/**
 * ─── AI SIMULATION ENGINE & DRIVER COORDINATOR ───
 * 
 * This file encapsulates the AI driver agent behavior, probability models, 
 * search status generators, and candidate matching logic. Separating these 
 * concerns enables a clean transition to production-grade real driver integrations,
 * such as a FastAPI Python backend with WebSockets.
 */

export interface Driver {
  id: string;
  name: string;
  avatar: string;
  vehicle: string;
  rating: number;
  online: boolean;
  coords: [number, number];
  acceptProb: number;
  responseTime: number;
  trips: number;
  phone: string;
}

/**
 * Calculates the realistic probability of an AI driver accepting a ride offer.
 * Factors in:
 * - Base acceptance probability of the driver's profile
 * - Surge multiplier (drivers are much more eager to pick up high-paying surge fares)
 * - Distance to pickup (drivers are less likely to accept long, unpaid pickup runs)
 * 
 * @param driver The driver profile
 * @param distanceKm Distance to the passenger's pickup location in km
 * @param surgeMultiplier Current active surge multiplier (e.g. 1.5)
 * @returns A probability value between 0.0 and 1.0
 */
export function calculateAcceptProbability(
  driver: Driver,
  distanceKm: number,
  surgeMultiplier: number
): number {
  let probability = driver.acceptProb;

  // Surge factor: +15% per 0.5x surge above normal (1.0x)
  if (surgeMultiplier > 1.0) {
    const excessSurge = surgeMultiplier - 1.0;
    probability += excessSurge * 0.30;
  }

  // Distance penalty: -8% per km of unpaid pickup run
  probability -= distanceKm * 0.08;

  // Clamp probability between 5% and 98% to preserve realistic random variance
  return Math.max(0.05, Math.min(0.98, probability));
}

/**
 * Simulates whether an AI driver decides to accept or reject an incoming dispatch.
 * 
 * @param driver The driver profile
 * @param distanceKm Distance to the passenger
 * @param surgeMultiplier Current ride surge multiplier
 * @returns boolean indicating acceptance
 */
export function simulateDriverDecision(
  driver: Driver,
  distanceKm: number,
  surgeMultiplier: number
): boolean {
  const finalProb = calculateAcceptProbability(driver, distanceKm, surgeMultiplier);
  return Math.random() < finalProb;
}

/**
 * Helper to calculate WGS-84 geodesic distance using the Haversine formula
 */
export function haversineKm(coord1: [number, number], coord2: [number, number]): number {
  const [lng1, lat1] = coord1;
  const [lng2, lat2] = coord2;
  
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Evaluates and filters drivers who are online and within the current search range.
 * 
 * @param drivers Complete list of system drivers
 * @param pickup Geodesic coordinate pair [lng, lat] of passenger pickup
 * @param radiusKm Active radar scan radius in kilometers
 * @returns Array of drivers in range sorted by closest distance first
 */
export function findDriversInRange(
  drivers: Driver[],
  pickup: [number, number],
  radiusKm: number
): { driver: Driver; distance: number }[] {
  return drivers
    .filter((d) => d.online)
    .map((d) => ({
      driver: d,
      distance: haversineKm(d.coords, pickup)
    }))
    .filter((item) => item.distance <= radiusKm)
    .sort((a, b) => a.distance - b.distance);
}
