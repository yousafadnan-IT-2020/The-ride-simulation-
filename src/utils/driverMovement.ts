/**
 * ─── DRIVER REAL-TIME MOVEMENT SIMULATION ENGINE ───
 * 
 * This file contains the core logic for simulating real-time GPS coordinates of active drivers.
 * In production, this simulation can be replaced with actual real-time GPS coordinates retrieved 
 * via WebSocket subscriptions or periodic REST API polls from the physical drivers' mobile apps.
 */

// Quantified global variables to control real-time GPS simulation
export const GPS_UPDATE_INTERVAL_MS = 2000; // Refresh frequency of simulated GPS updates (2 seconds)
export const SIMULATED_SPEED_KMPH = 18;     // Target simulated speed of online cruising vehicles (18 km/h)
export const HEADING_DRIFT_MAX_RAD = 0.6;   // Max heading angle drift per step (approx ~35 degrees) to simulate realistic street turns

// Derived coordinates step size (18 km/h = 5 m/s. At 2s intervals, step = 10m. 10m in degrees is ~0.00009)
export const SIMULATED_STEP_SIZE_DEG = 0.00009; 

export interface DriverCoords {
  id: string;
  coords: [number, number];
  heading?: number; // Optional heading angle in radians (0 to 2*PI)
}

/**
 * Simulates smooth, continuous, and realistic random walks for online operators.
 * This simulates cruising behavior when drivers are idle and waiting for dispatches.
 * Assures that:
 *  - Offline drivers do not move.
 *  - Drivers currently assigned to a ride ('en_route_to_pickup' or 'on_trip') do not move randomly,
 *    as their movement is strictly governed by the ride path navigation engine.
 * 
 * @param drivers Current list of drivers
 * @param activeDriverId The ID of the currently assigned/active driver (optional)
 * @returns A new list of drivers with updated coordinates
 */
export function simulateDriverMovements(
  drivers: any[],
  activeDriverId: string | null
): any[] {
  return drivers.map((driver) => {
    // Only simulate cruising movements for online drivers who are not currently active on a trip
    if (!driver.online || driver.id === activeDriverId) {
      return driver;
    }

    const [currentLng, currentLat] = driver.coords;

    // Retrieve or initialize heading (angle in radians)
    // We can use the driver's ID to generate a pseudo-stable initial heading, or drift it if already present
    let heading = (driver as any).heading;
    if (heading === undefined) {
      // Initialize with a random heading
      heading = Math.random() * 2 * Math.PI;
    }

    // Apply smooth random heading drift (between -HEADING_DRIFT_MAX_RAD and +HEADING_DRIFT_MAX_RAD)
    const drift = (Math.random() - 0.5) * 2 * HEADING_DRIFT_MAX_RAD;
    let newHeading = (heading + drift) % (2 * Math.PI);
    if (newHeading < 0) newHeading += 2 * Math.PI;

    // Calculate step coordinates using basic trigonometry
    const dLng = Math.cos(newHeading) * SIMULATED_STEP_SIZE_DEG;
    const dLat = Math.sin(newHeading) * SIMULATED_STEP_SIZE_DEG;

    const newLng = currentLng + dLng;
    const newLat = currentLat + dLat;

    return {
      ...driver,
      coords: [newLng, newLat] as [number, number],
      heading: newHeading
    };
  });
}
