import json
import math
import uuid
from typing import Dict, List, Set, Optional
from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

import models
import schemas
from database import engine, Base, get_db

# Initialize FastAPI application
app = FastAPI(
    title="Sawari Dispatch & Real-Time Tracking Core API",
    description="Production-ready FastAPI backend for live coordinate sync and high-tier ride matching",
    version="1.0.0"
)

# Enable CORS for cross-origin client apps
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Create tables on server startup if SQLite or Auto-migration is enabled
@app.on_event("startup")
def startup_db():
    Base.metadata.create_all(bind=engine)

# ─── WEBSOCKET COORDINATION MANAGER (ZERO-DELAY SYNC CHANNEL) ───
class TrackingConnectionManager:
    """
    Manages active websocket clients (passengers and drivers) to broadcast
    real-time driver GPS locations and ride state updates with 0-second latency.
    """
    def __init__(self):
        # Maps ride_id to a list of listening passenger/driver WebSocket connections
        self.active_ride_listeners: Dict[str, Set[WebSocket]] = {}
        # Simple global tracking connections list
        self.global_listeners: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket, ride_id: Optional[str] = None):
        await websocket.accept()
        if ride_id:
            if ride_id not in self.active_ride_listeners:
                self.active_ride_listeners[ride_id] = set()
            self.active_ride_listeners[ride_id].add(websocket)
        else:
            self.global_listeners.add(websocket)

    def disconnect(self, websocket: WebSocket, ride_id: Optional[str] = None):
        if ride_id and ride_id in self.active_ride_listeners:
            self.active_ride_listeners[ride_id].discard(websocket)
            if not self.active_ride_listeners[ride_id]:
                del self.active_ride_listeners[ride_id]
        self.global_listeners.discard(websocket)

    async def broadcast_driver_coordinates(self, driver_id: str, lat: float, lng: float, heading: Optional[float] = None):
        """
        Broadcasts driver movement coordinates instantly to all listeners.
        """
        message = {
            "type": "driver_telemetry",
            "driver_id": driver_id,
            "coords": [lng, lat],
            "heading": heading
        }
        payload = json.dumps(message)
        
        # Broadcast to all general live map listeners
        for connection in list(self.global_listeners):
            try:
                await connection.send_text(payload)
            except Exception:
                self.global_listeners.discard(connection)

    async def broadcast_ride_status_change(self, ride_id: str, status: str, driver_id: Optional[str] = None):
        """
        Broadcasts ride status updates directly to subscribers listening on that specific ride channel.
        """
        message = {
            "type": "ride_status_update",
            "ride_id": ride_id,
            "status": status,
            "driver_id": driver_id
        }
        payload = json.dumps(message)
        
        if ride_id in self.active_ride_listeners:
            for connection in list(self.active_ride_listeners[ride_id]):
                try:
                    await connection.send_text(payload)
                except Exception:
                    self.active_ride_listeners[ride_id].discard(connection)

manager = TrackingConnectionManager()


# ─── GEODESIC CALCULATIONS ───
def haversine_distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0 # Earth's radius in kilometers
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lng2 - lng1)

    a = (math.sin(delta_phi / 2) ** 2 +
         math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


# ─── REST ENDPOINTS ───

@app.get("/api/health")
def health_check():
    return {"status": "operational", "version": "1.0.0"}

# Get all drivers in the system
@app.get("/api/drivers", response_model=List[schemas.DriverResponse])
def get_drivers(db: Session = Depends(get_db)):
    return db.query(models.Driver).all()

# Register or add a driver to the database
@app.post("/api/drivers", response_model=schemas.DriverResponse)
def create_driver(driver_in: schemas.DriverCreate, db: Session = Depends(get_db)):
    db_driver = db.query(models.Driver).filter(models.Driver.id == driver_in.id).first()
    if db_driver:
        # Update details if already exists
        db_driver.name = driver_in.name
        db_driver.vehicle = driver_in.vehicle
        db_driver.phone = driver_in.phone
        db_driver.lat = driver_in.lat
        db_driver.lng = driver_in.lng
    else:
        db_driver = models.Driver(
            id=driver_in.id,
            name=driver_in.name,
            avatar=driver_in.avatar,
            vehicle=driver_in.vehicle,
            lat=driver_in.lat,
            lng=driver_in.lng,
            phone=driver_in.phone,
            online=True
        )
        db.add(db_driver)
    
    db.commit()
    db.refresh(db_driver)
    return db_driver

# Real-Time Telemetry Route for GPS updates (No-Delay Sync)
@app.post("/api/drivers/ping")
async def ping_driver_location(ping: schemas.CoordinatePing, db: Session = Depends(get_db)):
    driver = db.query(models.Driver).filter(models.Driver.id == ping.driver_id).first()
    if not driver:
        raise HTTPException(status_code=404, detail="Driver not found")
    
    # Update current position
    driver.lat = ping.lat
    driver.lng = ping.lng
    driver.online = True
    
    # Log movement history
    history_log = models.LocationPing(driver_id=ping.driver_id, lat=ping.lat, lng=ping.lng)
    db.add(history_log)
    db.commit()

    # Trigger instantaneous broadcast to all active websockets with 0 delay!
    await manager.broadcast_driver_coordinates(ping.driver_id, ping.lat, ping.lng)
    
    return {"status": "success", "lat": ping.lat, "lng": ping.lng}


# Booking & Ride Requests Endpoints
@app.post("/api/rides", response_model=schemas.RideResponse)
async def request_ride(ride_in: schemas.RideCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    ride_id = "SWR-" + str(uuid.uuid4())[:8].upper()
    db_ride = models.Ride(
        id=ride_id,
        status="searching",
        pickup_lat=ride_in.pickup_lat,
        pickup_lng=ride_in.pickup_lng,
        dest_lat=ride_in.dest_lat,
        dest_lng=ride_in.dest_lng,
        fare=ride_in.fare,
        surge=ride_in.surge
    )
    db.add(db_ride)
    db.commit()
    db.refresh(db_ride)

    # Launch background matching dispatch task
    background_tasks.add_task(dispatch_matching_job, ride_id, db_ride.pickup_lat, db_ride.pickup_lng)
    
    return db_ride

@app.get("/api/rides/{ride_id}", response_model=schemas.RideResponse)
def get_ride(ride_id: str, db: Session = Depends(get_db)):
    ride = db.query(models.Ride).filter(models.Ride.id == ride_id).first()
    if not ride:
        raise HTTPException(status_code=404, detail="Ride not found")
    return ride


# ─── REAL-TIME LOGISTIC MATCHING ALGORITHM (FASTAPI BACKEND CORE) ───
async def dispatch_matching_job(ride_id: str, pickup_lat: float, pickup_lng: float):
    """
    Simulates production backend dispatch matching.
    Queries database for online drivers, processes distance filters, 
    and progresses the matching sweep from 1.0 km up to 25.0 km to match.
    """
    import asyncio
    db: Session = SessionLocal()
    try:
        # Step 1: Start at tight 1.0 km search radius
        search_radius = 1.0
        matched_driver = None
        
        while search_radius <= 25.0 and not matched_driver:
            # Query online drivers
            online_drivers = db.query(models.Driver).filter(models.Driver.online == True).all()
            
            candidates = []
            for d in online_drivers:
                dist = haversine_distance_km(pickup_lat, pickup_lng, d.lat, d.lng)
                if dist <= search_radius:
                    candidates.append((d, dist))
                    
            # Sort by distance
            candidates.sort(key=lambda x: x[1])
            
            if candidates:
                # Select the nearest candidate driver (up to 5 can be notified via websocket)
                # For this demo, let's auto-assign the closest active operator
                matched_driver = candidates[0][0]
                break
                
            # Slowly expand range by 1km every second up to 5km
            if search_radius < 5.0:
                await asyncio.sleep(1.0)
                search_radius += 1.0
            else:
                # Beyond 5km, expand in larger leaps of 5km every 2 seconds
                await asyncio.sleep(2.0)
                search_radius += 5.0

        ride = db.query(models.Ride).filter(models.Ride.id == ride_id).first()
        if ride:
            if matched_driver:
                ride.driver_id = matched_driver.id
                ride.status = "en_route_to_pickup"
                db.commit()
                # Broadcast status updates to websocket channels with 0 delay!
                await manager.broadcast_ride_status_change(ride_id, "en_route_to_pickup", matched_driver.id)
            else:
                ride.status = "failed"
                db.commit()
                await manager.broadcast_ride_status_change(ride_id, "failed")
    finally:
        db.close()


# ─── WEBSOCKET ROUTE (REAL-TIME STREAM) ───
@app.websocket("/ws/tracking")
async def ws_tracking_endpoint(websocket: WebSocket, ride_id: Optional[str] = None):
    await manager.connect(websocket, ride_id)
    try:
        while True:
            # Keep connection alive; clients can send telemetry here or standard ping-pongs
            data = await websocket.receive_text()
            # If coordinates are sent directly via client websockets, broadcast instantly!
            try:
                msg = json.loads(data)
                if msg.get("type") == "driver_telemetry":
                    driver_id = msg["driver_id"]
                    coords = msg["coords"]
                    heading = msg.get("heading")
                    await manager.broadcast_driver_coordinates(driver_id, coords[1], coords[0], heading)
            except Exception:
                pass
    except WebSocketDisconnect:
        manager.disconnect(websocket, ride_id)
