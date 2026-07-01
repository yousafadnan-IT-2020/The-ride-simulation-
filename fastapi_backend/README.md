# 🛺 Sawari FastAPI Real-Time GPS Tracking & Dispatch Core Backend

This directory houses the high-performance, asynchronous Python FastAPI server configured for sub-second, real-time driver coordinate synchronization, persistent SQL storage, and intelligent geospatial ride dispatching. 

In production, the simulated frontend agents are replaced by real-world driver and passenger mobile apps connected directly to this backend over WebSockets, guaranteeing zero latency.

---

## 🚀 Key Features
- **0ms WebSocket Telemetry Broadcast**: Instant coordinates synchronization from the active driver GPS to passenger tracking cards.
- **Progressive Radar Matching Engine**: Geospatial queries starting at `1.0 km` and scaling dynamically by `1.0 km` every second to find candidate drivers.
- **PostgreSQL Database Integration**: Comprehensive schema modeling for drivers, passengers, rides, and historical telemetry GPS audits.
- **CORS-Enabled REST API**: Fully compatible with client apps, React-Vite frontends, and native applications.

---

## 🛠️ Installation and Setup

### 1. Prerequisites
- Python 3.9, 3.10, or 3.11 installed.
- PostgreSQL Database installed (optional, falls back to local lightweight SQLite natively for zero-configuration testing).

### 2. Install Dependencies
Create a virtual environment and install the required packages:
```bash
# Navigate to the backend directory
cd fastapi_backend

# Create a virtual environment
python -m venv venv

# Activate the virtual environment
# On macOS/Linux:
source venv/bin/activate
# On Windows:
venv\Scripts\activate

# Install high-performance package stack
pip install -r requirements.txt
```

### 3. Environment Variables
You can configure database credentials using standard environment variables. Create a `.env` file or export variables:
```env
DATABASE_URL=postgresql://your_db_user:your_db_password@localhost:5432/sawari_db
```
*(If `DATABASE_URL` is omitted, the API automatically provisions a local SQL database `sawari.db` instantly via SQLite).*

---

## ⚡ Running the Server

Start the ASGI server using `uvicorn` with auto-reload enabled for rapid iterative development:
```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

The server will initialize and begin serving traffic on:
- **REST Endpoints & Docs**: `http://localhost:8000`
- **Interactive Swagger Documentation**: `http://localhost:8000/docs`
- **Sub-Second WebSocket Channel**: `ws://localhost:8000/ws/tracking`

---

## 📑 API Endpoints Summary

### 🚕 Driver Operations
- **`GET /api/drivers`**: Retrieve all registered operators and their current coordinates.
- **`POST /api/drivers`**: Register a new vehicle operator.
- **`POST /api/drivers/ping`**: Submit live GPS coordinate telemetry. This instantly fires a broadcast message over WebSocket channels to listening passengers.

### 🗺️ Ride Operations
- **`POST /api/rides`**: Initiate a ride request from current pickup coordinates to destination. Automatically starts the matching engine in a separate concurrent thread.
- **`GET /api/rides/{id}`**: Query status and details for an active ride.

---

## 🔌 Connecting client apps via WebSockets
To connect the user panel to the driver panel with zero lag, initialize a WebSocket connection from the browser:

```javascript
// Connect to the ride-specific tracking channel
const socket = new WebSocket("ws://localhost:8000/ws/tracking?ride_id=SWR-89A2BF");

// Listen for incoming coordinate coordinates or status changes
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  if (message.type === "driver_telemetry") {
    console.log(`Driver ${message.driver_id} moved to:`, message.coords);
    // Update map marker positions instantly without reloading!
    updateMapMarker(message.driver_id, message.coords);
  }
  
  if (message.type === "ride_status_update") {
    console.log("Ride status updated:", message.status);
    updateUserPanel(message.status);
  }
};
```
