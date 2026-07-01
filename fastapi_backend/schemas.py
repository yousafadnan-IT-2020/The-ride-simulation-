from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime

class DriverBase(BaseModel):
    name: str
    vehicle: str
    avatar: Optional[str] = "👨"
    phone: Optional[str] = None

class DriverCreate(DriverBase):
    id: str
    lat: float
    lng: float

class DriverResponse(DriverBase):
    id: str
    rating: float
    online: bool
    lat: float
    lng: float
    trips: int
    last_updated: datetime

    class Config:
        from_attributes = True

class CoordinatePing(BaseModel):
    driver_id: str
    lat: float
    lng: float

class RideCreate(BaseModel):
    pickup_lat: float
    pickup_lng: float
    dest_lat: float
    dest_lng: float
    surge: float = 1.0
    fare: float

class RideResponse(BaseModel):
    id: str
    driver_id: Optional[str] = None
    status: str
    pickup_lat: float
    pickup_lng: float
    dest_lat: float
    dest_lng: float
    fare: float
    surge: float
    created_at: datetime

    class Config:
        from_attributes = True
