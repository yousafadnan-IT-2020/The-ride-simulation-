/**
 * 🎯 TEST DRIVER SIMULATION DATABASE & GENERATION ENGINE
 * 
 * =========================================================================
 * CLIENT DOCUMENTATION:
 * 
 * This file is completely separated from the core application logic to act as a 
 * "Driver Data Layer" mock. It provides:
 * 1. Default test drivers (such as Muhammad Ali, Zainab Bibi, etc.) who initially 
 *    populate the simulator.
 * 2. An automated real-time driver generator (`createDriver`) that dynamically 
 *    allocates active online drivers near any user's real coordinate (GPS or map-click).
 * 
 * FUTURE PRODUCTION INTEGRATION:
 * When migrating this application to a real production environment, you can safely 
 * discard or modify this file. To connect to a live backend database or third-party API:
 * 1. Replace the static `DEFAULT_DRIVERS` array with a standard database query 
 *    (e.g., SELECT * FROM drivers WHERE active = true) or an API fetch (e.g., GET /api/v1/drivers).
 * 2. Replace the local coordinate randomizers in `createDriver` with actual real-time 
 *    GPS coordinate streams received from driver-side mobile applications (WebSockets/gRPC).
 * =========================================================================
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

// Islamabad center coordinates used as fallback center
export const ISLAMABAD_CENTER: [number, number] = [73.0479, 33.6844];

export const DRIVER_NAMES = [
  'Ahmed Khan', 'Bilal Raza', 'Usman Ali', 'Faisal Malik', 'Tariq Shah',
  'Imran Hussain', 'Zubair Akhtar', 'Nadeem Qureshi', 'Waseem Baig', 'Kamran Javed',
  'Saeed Anwar', 'Hassan Mirza', 'Rizwan Chaudhry', 'Asad Butt', 'Hamid Ullah',
  'Mehmood', 'Naveed Iqbal', 'Danish Siddiqui', 'Arif Nawaz', 'Jawad Cheema'
];

export const VEHICLE_TYPES = ['🚗 Economy', '🚙 Comfort', '🚐 XL', '🏍️ Bike', '⚡ Electric'];
export const AVATARS = ['🧔', '👨', '🧑', '👱', '🧓', '👲', '🧔‍♂️', '👦', '🧑‍🦱', '🧑‍🦳'];

let driverIdCounter = 100; // start custom generation above default drivers

// Local simulation helper functions
function randBetween(a: number, b: number) {
  return Math.random() * (b - a) + a;
}

function randInt(a: number, b: number) {
  return Math.floor(randBetween(a, b + 1));
}

function randItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generates a high-quality test driver relative to a coordinate.
 * If no coordinate is provided, defaults to the center location.
 */
export function createDriver(lngLat?: [number, number], centerCoords?: [number, number]): Driver {
  const baseCenter = centerCoords || ISLAMABAD_CENTER;
  const targetCoords: [number, number] = lngLat
    ? [...lngLat]
    : [
        baseCenter[0] + randBetween(-0.06, 0.06),
        baseCenter[1] + randBetween(-0.05, 0.05)
      ];

  return {
    id: 'd_' + driverIdCounter++,
    name: randItem(DRIVER_NAMES),
    avatar: randItem(AVATARS),
    vehicle: randItem(VEHICLE_TYPES),
    rating: parseFloat(randBetween(3.8, 5.0).toFixed(1)),
    online: true, // Auto-online for smooth immediate dispatch testing
    coords: targetCoords,
    acceptProb: parseFloat(randBetween(0.65, 0.98).toFixed(2)),
    responseTime: randItem([3, 4, 5, 6, 7]),
    trips: randInt(25, 950),
    phone:
      '+92 3' +
      randInt(0, 99).toString().padStart(2, '0') +
      ' ' +
      randInt(1000000, 9999999)
  };
}

/**
 * Pre-configured list containing ONLY the Universal Test Driver.
 * This guarantees a clean, professional, clutter-free map environment for testing.
 * 
 * PRODUCTION READY INTEGRATION:
 * In a production environment, this mock driver layer can be completely removed and replaced
 * with a live backend database (e.g. Postgres + PostGIS) or WebSocket streams receiving
 * active real-time GPS locations from driver-side mobile applications.
 */
export const DEFAULT_DRIVERS: Driver[] = [
  {
    id: 'd_test_universal',
    name: 'Universal Test Driver',
    avatar: '🚗',
    vehicle: '⚡ Hybrid Sedan (Test Car)',
    rating: 5.0,
    responseTime: 4,
    acceptProb: 0.99, // Guaranteed high acceptance
    online: true,
    coords: [73.0479, 33.6844], // Islamabad F-8 Area (Default Fallback Center)
    trips: 999,
    phone: '+92 300 0000000'
  }
];
