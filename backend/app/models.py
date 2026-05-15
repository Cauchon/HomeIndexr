from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class AddPropertyRequest(BaseModel):
    address: str
    confirm_mismatch: bool = False


class Snapshot(BaseModel):
    id: int
    property_id: int
    fetched_at: int
    status: str
    matched_address: str | None = None
    best_current_estimate: int | None = None
    estimate_source: str | None = None
    estimate_low: int | None = None
    estimate_high: int | None = None
    estimate_date: str | None = None
    list_price: int | None = None
    sold_price: int | None = None
    last_sold_price: int | None = None
    beds: int | None = None
    baths: float | None = None
    sqft: int | None = None
    lot_sqft: int | None = None
    year_built: int | None = None
    latitude: float | None = None
    longitude: float | None = None
    raw_json: Any = None
    error: str | None = None


class Property(BaseModel):
    id: int
    input_address: str
    canonical_address: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    property_id: str | None = None
    listing_id: str | None = None
    property_url: str | None = None
    listing_state: str | None = None
    active: bool = True
    status: str = "matched"
    created_at: int
    updated_at: int
    snapshots: list[Snapshot] = []


class AddPropertyResponse(BaseModel):
    status: str  # matched | candidate_mismatch | no_candidates | error
    property: Property | None = None
    candidate: dict | None = None
    error: str | None = None
