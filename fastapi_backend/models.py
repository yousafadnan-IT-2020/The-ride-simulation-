from sqlalchemy import Column, String, Float, Boolean, Integer, DateTime, ForeignKey
from sqlalchemy.sql import func
from database import Base

class Driver(Base):
    __tablename__ = "drivers"

    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    avatar = Column(String, nullable=True)
    vehicle = Column(String, nullable=False)
    rating = Column(Float, default=5.0)
    online = Column(Boolean, default=False)
    lat = Column(Float, nullable=False)
    lng = Column(Float, nullable=False)
    phone = Column(String, nullable=True)
    trips = Column(Integer, default=0)
    last_updated = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

class Ride(Base):
    __tablename__ = "rides"

    id = Column(String, primary_key=True, index=True)
    driver_id = Column(String, ForeignKey("drivers.id"), nullable=True)
    status = Column(String, default="idle") # idle, searching, en_route_to_pickup, arrived_at_pickup, on_trip, completed, failed
    pickup_lat = Column(Float, nullable=False)
    pickup_lng = Column(Float, nullable=False)
    dest_lat = Column(Float, nullable=False)
    dest_lng = Column(Float, nullable=False)
    fare = Column(Float, nullable=True)
    surge = Column(Float, default=1.0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)

class LocationPing(Base):
    __tablename__ = "location_pings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    driver_id = Column(String, ForeignKey("drivers.id"), index=True)
    lat = Column(Float, nullable=False)
    lng = Column(Float, nullable=False)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
