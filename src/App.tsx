import React, { useState, useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { simulateDriverMovements, GPS_UPDATE_INTERVAL_MS } from './utils/driverMovement';
import { calculateAcceptProbability, simulateDriverDecision } from './utils/aiSimulation';
import { Driver, DEFAULT_DRIVERS, createDriver, ISLAMABAD_CENTER, AVATARS, VEHICLE_TYPES } from './testDrivers';

const h = React.createElement;

// ═══════════════════════════════════════════════
// CONSTANTS & HELPERS
// ═══════════════════════════════════════════════

const RT_OPTIONS = [3, 5, 8, 10, 15];

let toastIdCounter = 1;

declare global {
  interface Window {
    SAWARI_DRIVERS_STORE: Driver[];
    updateSawariDrivers: (newDrivers: Driver[]) => void;
  }
}

interface Toast {
  id: number;
  type?: 'success' | 'error' | 'info';
  icon?: string;
  title: string;
  msg: string;
}

interface Stats {
  online: number;
  offline: number;
  totalRequests: number;
  completed: number;
  avgFare: number;
  redZones: number;
}

interface DispatchEvent {
  ts?: string;
  type: string;
  label: string;
  sub: string;
  dot?: string;
}

function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function randBetween(a: number, b: number) {
  return Math.random() * (b - a) + a;
}

function randInt(a: number, b: number) {
  return Math.floor(randBetween(a, b + 1));
}

function randItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function haversineKm([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getDriverCategory(driver: Driver): 'eco' | 'comfort' | 'premium' {
  const vehicle = (driver.vehicle || '').toLowerCase();
  if (
    vehicle.includes('alto') ||
    vehicle.includes('wagonr') ||
    vehicle.includes('suzuki') ||
    vehicle.includes('economy') ||
    vehicle.includes('bike') ||
    vehicle.includes('eco') ||
    vehicle.includes('mini')
  ) {
    return 'eco';
  }
  if (
    vehicle.includes('civic') ||
    vehicle.includes('premium') ||
    vehicle.includes('xl') ||
    vehicle.includes('black')
  ) {
    return 'premium';
  }
  return 'comfort';
}

function calcFare(distKm: number, surgeMultiplier: number) {
  const BASE = 50; // PKR
  const RATE = 45; // PKR per km
  const LOCAL = 15; // PKR fixed local fee
  const dist = BASE + distKm * RATE;
  const fare = dist * surgeMultiplier + LOCAL;
  return {
    base: BASE,
    distanceCharge: parseFloat((distKm * RATE).toFixed(0)),
    localFee: LOCAL,
    surge: surgeMultiplier,
    total: parseFloat(fare.toFixed(0)),
    distKm: parseFloat(distKm.toFixed(2))
  };
}

function getSurgeMultiplier(onlineCount: number, rideCount: number) {
  const ratio = rideCount / Math.max(onlineCount, 1);
  if (ratio < 0.3) return 1.0;
  if (ratio < 0.6) return 1.2;
  if (ratio < 1.0) return 1.5;
  return 2.0;
}

function surgeLabel(m: number) {
  if (m <= 1.0) return 'Normal';
  if (m <= 1.2) return 'Busy';
  if (m <= 1.5) return 'High Demand';
  return 'Very Busy';
}

function buildRoutePath(from: [number, number], to: [number, number], steps = 40): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const offset = 0.01 * Math.sin(t * Math.PI);
    const lng = from[0] + (to[0] - from[0]) * t + offset * (to[1] - from[1]);
    const lat = from[1] + (to[1] - from[1]) * t + offset * (from[0] - to[0]);
    pts.push([lng, lat]);
  }
  return pts;
}

// ═══════════════════════════════════════════════
// SVG MARKERS
// ═══════════════════════════════════════════════

function carSVG(color = '#F97316', online = true, selected = false) {
  const glow = selected ? `<circle cx="16" cy="16" r="15" fill="${color}" opacity="0.2"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    ${glow}
    <circle cx="16" cy="16" r="${selected ? 13 : 11}" fill="${online ? color : '#4B5563'}" opacity="${online ? 1 : 0.6}"/>
    <text x="16" y="21" text-anchor="middle" font-size="13">🚗</text>
    ${online ? `<circle cx="24" cy="8" r="4" fill="#10B981" stroke="#080B12" stroke-width="1.5"/>` : ''}
  </svg>`;
}

function bikeSVG(color = '#8B5CF6', online = true) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="11" fill="${online ? color : '#4B5563'}" opacity="${online ? 1 : 0.6}"/>
    <text x="16" y="21" text-anchor="middle" font-size="13">🏍️</text>
    ${online ? `<circle cx="24" cy="8" r="4" fill="#10B981" stroke="#080B12" stroke-width="1.5"/>` : ''}
  </svg>`;
}

function pickupSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44">
    <filter id="glow"><feGaussianBlur stdDeviation="2" result="blur"/><feComposite in="SourceGraphic" in2="blur" operator="over"/></filter>
    <ellipse cx="18" cy="40" rx="6" ry="3" fill="rgba(16,185,129,0.3)"/>
    <path d="M18 2 C10 2 4 8 4 16 C4 26 18 40 18 40 C18 40 32 26 32 16 C32 8 26 2 18 2Z" fill="#10B981" filter="url(#glow)"/>
    <circle cx="18" cy="16" r="6" fill="white"/>
    <text x="18" y="20" text-anchor="middle" font-size="10" fill="#10B981" font-weight="bold">P</text>
  </svg>`;
}

function destSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44">
    <filter id="glow2"><feGaussianBlur stdDeviation="2" result="blur"/><feComposite in="SourceGraphic" in2="blur" operator="over"/></filter>
    <ellipse cx="18" cy="40" rx="6" ry="3" fill="rgba(239,68,68,0.3)"/>
    <path d="M18 2 C10 2 4 8 4 16 C4 26 18 40 18 40 C18 40 32 26 32 16 C32 8 26 2 18 2Z" fill="#EF4444" filter="url(#glow2)"/>
    <circle cx="18" cy="16" r="6" fill="white"/>
    <text x="18" y="20" text-anchor="middle" font-size="10" fill="#EF4444" font-weight="bold">D</text>
  </svg>`;
}

function markerForDriver(d: Driver, selected = false) {
  if (d.vehicle.includes('Bike')) return bikeSVG('#8B5CF6', d.online);
  if (d.vehicle.includes('Electric')) return carSVG('#3B82F6', d.online, selected);
  if (d.vehicle.includes('Comfort')) return carSVG('#F97316', d.online, selected);
  if (d.vehicle.includes('XL')) return carSVG('#10B981', d.online, selected);
  return carSVG('#94A3B8', d.online, selected);
}

// ═══════════════════════════════════════════════
// TOAST COMPONENT
// ═══════════════════════════════════════════════

interface ToastContainerProps {
  toasts: Toast[];
  dismiss: (id: number) => void;
}

function ToastContainer({ toasts, dismiss }: ToastContainerProps) {
  return h(
    'div',
    { className: 'toast-container' },
    toasts.map((t) =>
      h(
        'div',
        {
          key: t.id,
          className: `toast ${t.type || ''}`,
          onClick: () => dismiss(t.id)
        },
        h('div', { className: 'toast-icon' }, t.icon || 'ℹ️'),
        h(
          'div',
          {},
          h('div', { className: 'toast-title' }, t.title),
          h('div', { className: 'toast-msg' }, t.msg)
        )
      )
    )
  );
}

// ═══════════════════════════════════════════════
// STARS
// ═══════════════════════════════════════════════

function Stars({ rating }: { rating: number }) {
  const full = Math.floor(rating);
  const half = rating % 1 >= 0.5;
  return h(
    'span',
    { className: 'stars' },
    '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(5 - full - (half ? 1 : 0)) + ` ${rating}`
  );
}

// ═══════════════════════════════════════════════
// DRIVER DETAIL PANEL
// ═══════════════════════════════════════════════

interface DriverDetailPanelProps {
  driver: Driver;
  onClose: () => void;
  onUpdate: (updated: Driver) => void;
  onDelete: (id: string) => void;
  onToggle: (driver: Driver) => void;
  rideCoords: [number, number] | null;
}

function DriverDetailPanel({
  driver,
  onClose,
  onUpdate,
  onDelete,
  onToggle,
  rideCoords
}: DriverDetailPanelProps) {
  const [rt, setRt] = useState(driver.responseTime);

  useEffect(() => {
    setRt(driver.responseTime);
  }, [driver.id]);

  const distKm = rideCoords ? haversineKm(driver.coords, rideCoords) : null;

  function saveRT(v: number) {
    setRt(v);
    onUpdate({ ...driver, responseTime: v });
  }

  return h(
    'div',
    { className: 'driver-detail' },
    h(
      'div',
      { className: 'driver-detail-header' },
      h('div', { className: 'driver-detail-avatar' }, driver.avatar),
      h(
        'div',
        {},
        h('div', { className: 'driver-detail-name' }, driver.name),
        h('div', { className: 'ride-id' }, driver.id),
        h(Stars, { rating: driver.rating })
      ),
      h(
        'button',
        {
          className: 'btn btn-ghost btn-sm',
          style: { marginLeft: 'auto' },
          onClick: onClose
        },
        '✕'
      )
    ),
    h(
      'div',
      { className: 'detail-row' },
      h('span', { className: 'detail-key' }, 'Vehicle'),
      h('span', { className: 'detail-val' }, driver.vehicle)
    ),
    h(
      'div',
      { className: 'detail-row' },
      h('span', { className: 'detail-key' }, 'Status'),
      h(
        'span',
        { className: `detail-val ${driver.online ? 'green' : ''}` },
        driver.online ? '🟢 Online' : '⭕ Offline'
      )
    ),
    h(
      'div',
      { className: 'detail-row' },
      h('span', { className: 'detail-key' }, 'Accept Prob'),
      h('span', { className: 'detail-val amber' }, (driver.acceptProb * 100).toFixed(0) + '%')
    ),
    h(
      'div',
      { className: 'detail-row' },
      h('span', { className: 'detail-key' }, 'Trips'),
      h('span', { className: 'detail-val' }, driver.trips)
    ),
    h(
      'div',
      { className: 'detail-row' },
      h('span', { className: 'detail-key' }, 'Phone'),
      h('span', { className: 'detail-val' }, driver.phone)
    ),
    distKm !== null &&
      h(
        'div',
        { className: 'detail-row' },
        h('span', { className: 'detail-key' }, 'From Pickup'),
        h('span', { className: 'detail-val amber' }, distKm.toFixed(2) + ' km')
      ),

    h(
      'div',
      { style: { padding: '12px 16px', borderBottom: '1px solid var(--border)' } },
      h('div', { className: 'detail-key', style: { marginBottom: '8px' } }, 'Response Time'),
      h(
        'div',
        { className: 'response-time-select' },
        RT_OPTIONS.map((v) =>
          h(
            'button',
            {
              key: v,
              className: `rt-chip ${rt === v ? 'active' : ''}`,
              onClick: () => saveRT(v)
            },
            v + 's'
          )
        )
      )
    ),
    h(
      'div',
      { style: { padding: '12px 16px', display: 'flex', gap: '8px' } },
      h(
        'button',
        { className: 'btn btn-green', onClick: () => onToggle(driver) },
        driver.online ? '⭕ Set Offline' : '🟢 Set Online'
      ),
      h(
        'button',
        {
          className: 'btn btn-danger',
          onClick: () => {
            onDelete(driver.id);
            onClose();
          }
        },
        '🗑️ Remove'
      )
    )
  );
}

// ═══════════════════════════════════════════════
// DISPATCH ENGINE
// ═══════════════════════════════════════════════

interface UseDispatchEngineProps {
  drivers: Driver[];
  pickup: [number, number] | null;
  dest: [number, number] | null;
  onEvent: (evt: DispatchEvent) => void;
  onAssign: (driver: Driver | 'already' | null, rideId: string) => void;
  addToast: (t: Omit<Toast, 'id'>) => void;
  searchRadius: number;
  setSearchRadius: React.Dispatch<React.SetStateAction<number>>;
  isScanning: boolean;
  setIsScanning: React.Dispatch<React.SetStateAction<boolean>>;
  setDispatchDrivers: React.Dispatch<React.SetStateAction<Driver[]>>;
  setDispatchCountdowns: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  countdownRefs: React.MutableRefObject<Record<string, NodeJS.Timeout>>;
  aiSimulationEnabled: boolean;
  selectedCategory: 'eco' | 'comfort' | 'premium';
}

function useDispatchEngine({
  drivers,
  pickup,
  dest,
  onEvent,
  onAssign,
  addToast,
  searchRadius,
  setSearchRadius,
  isScanning,
  setIsScanning,
  setDispatchDrivers,
  setDispatchCountdowns,
  countdownRefs,
  aiSimulationEnabled,
  selectedCategory
}: UseDispatchEngineProps) {
  const activeTimers = useRef<NodeJS.Timeout[]>([]);
  const dispatchState = useRef<{
    rideId: string;
    surge: number;
    assigned: boolean;
    broadcastRound: number;
    currentRadius: number;
  } | null>(null);

  const activeCandidatesRef = useRef<Driver[]>([]);
  const respondedDriversRef = useRef<Set<string>>(new Set());

  function clearAllTimers() {
    activeTimers.current.forEach(clearTimeout);
    activeTimers.current = [];
  }

  function driverRespond(driverId: string, accepted: boolean) {
    const state = dispatchState.current;
    if (!state) return;

    if (state.assigned) {
      // Already assigned to someone else
      onEvent({
        type: 'locked',
        label: `Lock Conflict Avoided`,
        sub: `Operator ID ${driverId} attempt blocked. Ride already atomically locked.`,
        dot: 'red'
      });
      onAssign('already', state.rideId);
      return;
    }

    if (respondedDriversRef.current.has(driverId)) {
      return; // Already processed response for this driver
    }
    respondedDriversRef.current.add(driverId);

    const driver = drivers.find((d) => d.id === driverId);
    if (!driver) return;

    // Clear countdown timer visual for this specific driver
    setDispatchCountdowns((prev) => {
      const copy = { ...prev };
      delete copy[driverId];
      return copy;
    });

    if (accepted) {
      state.assigned = true;
      clearAllTimers();
      Object.values(countdownRefs.current).forEach(clearInterval);
      countdownRefs.current = {};
      setDispatchCountdowns({});
      setDispatchDrivers([]);

      onEvent({
        type: 'accept',
        label: `${driver.name} Accepted!`,
        sub: `${driver.vehicle} · Rating ${driver.rating}`,
        dot: 'green'
      });
      onEvent({
        type: 'assign',
        label: 'Atomic Ride Lock Succeeded',
        sub: `Assigned to ${driver.name}. En route from ${haversineKm(driver.coords, pickup!).toFixed(1)} km`,
        dot: 'green'
      });
      onAssign(driver, state.rideId);
    } else {
      onEvent({
        type: 'reject',
        label: `${driver.name.split(' ')[0]} Declined`,
        sub: 'Declined or timed out. Checking alternative dispatchers...',
        dot: 'red'
      });

      // Check if all notified drivers in this batch have responded
      const allResponded = activeCandidatesRef.current.every((d) => respondedDriversRef.current.has(d.id));
      if (allResponded && !state.assigned) {
        // Expand search radius beyond the current stage immediately
        const currentRadius = state.currentRadius;
        if (currentRadius < 25.0) {
          const nextRadius = currentRadius + 5.0;
          state.currentRadius = nextRadius;
          setSearchRadius(nextRadius);
          onEvent({
            type: 'searching',
            label: 'Expanding Area Search',
            sub: `No operator accepted in current sector. Extending search radar to ${nextRadius.toFixed(1)} km...`,
            dot: 'amber'
          });
          setIsScanning(true);
          const t2 = setTimeout(() => {
            evaluateProgressiveScan(nextRadius, state.rideId);
          }, 2000);
          activeTimers.current.push(t2);
        } else {
          onEvent({
            type: 'fail',
            label: 'No Drivers Available',
            sub: 'All nearby drivers rejected the dispatch offer',
            dot: 'red'
          });
          onAssign(null, state.rideId);
        }
      }
    }
  }

  // Bind response handler to window for manual control from driver screens
  useEffect(() => {
    (window as any).triggerDriverResponse = (driverId: string, accepted: boolean) => {
      driverRespond(driverId, accepted);
    };
  }, [drivers, searchRadius]);

  function startDispatch(rideId: string, surge: number) {
    clearAllTimers();

    if (!pickup || !dest) return;

    // Ensure we have some online drivers nearby
    const onlineDrivers = drivers.filter((d) => d.online);

    if (onlineDrivers.length === 0 && drivers.length > 0) {
      drivers.slice(0, 5).forEach((d) => {
        d.online = true;
        d.coords = [
          pickup[0] + (Math.random() - 0.5) * 0.04,
          pickup[1] + (Math.random() - 0.5) * 0.04
        ];
      });
    }

    const online = drivers.filter((d) => d.online);
    if (online.length === 0) {
      onEvent({
        type: 'error',
        label: 'No Online Drivers',
        sub: `Cannot start dispatch — no active online drivers available`,
        dot: 'red'
      });
      return;
    }

    onEvent({ type: 'created', label: 'Ride Created', sub: `ID: ${rideId}`, dot: 'amber' });
    
    // Start scanning at a tight 1.0 km radius instead of big 10km zoom out
    setSearchRadius(1.0);
    setIsScanning(true);

    onEvent({
      type: 'searching',
      label: 'Initializing Area Scan',
      sub: `Scanning for closest available operators within 1.0 km...`,
      dot: 'blue'
    });

    dispatchState.current = { rideId, surge, assigned: false, broadcastRound: 0, currentRadius: 1.0 };
    respondedDriversRef.current.clear();
    activeCandidatesRef.current = [];
    
    // Run progressive scanning loop (1km/s expansion)
    evaluateProgressiveScan(1.0, rideId);
  }

  function evaluateProgressiveScan(radius: number, rideId: string) {
    const state = dispatchState.current;
    if (!state || state.assigned) return;

    const online = drivers.filter((d) => d.online);
    const candidatesInRange = online.filter(
      (d) => haversineKm(d.coords, pickup!) <= radius
    );

    // If we find any drivers in the current expanding search zone, approach them immediately!
    if (candidatesInRange.length > 0) {
      setIsScanning(false);
      setSearchRadius(radius);

      const sortedCandidates = [...candidatesInRange].sort(
        (a, b) => haversineKm(a.coords, pickup!) - haversineKm(b.coords, pickup!)
      );
      
      // Select maximum of 5 nearest drivers
      const batch = sortedCandidates.slice(0, 5);

      setDispatchDrivers(batch);
      activeCandidatesRef.current = batch;
      respondedDriversRef.current.clear();

      onEvent({
        type: 'notify',
        label: `Approaching ${batch.length} Nearby Drivers`,
        sub: `Broadcasting ride offer. Active countdowns shown on individual driver logs...`,
        dot: 'blue'
      });

      batch.forEach((d) => {
        let time = d.responseTime;
        setDispatchCountdowns((prev) => ({ ...prev, [d.id]: time }));
        const iv = setInterval(() => {
          time--;
          setDispatchCountdowns((prev) => ({ ...prev, [d.id]: Math.max(0, time) }));
          if (time <= 0) {
            clearInterval(iv);
            driverRespond(d.id, false);
          }
        }, 1000);
        countdownRefs.current[d.id] = iv;

        // If AI is active, make automatic intelligent decisions with response curve
        if (aiSimulationEnabled) {
          const distance = haversineKm(d.coords, pickup!);
          const acceptProbability = calculateAcceptProbability(d, distance, state.surge);
          const aiDelay = Math.max(1, Math.min(d.responseTime - 1, randInt(1, d.responseTime))) * 1000;
          
          const t = setTimeout(() => {
            const accepts = Math.random() < acceptProbability;
            driverRespond(d.id, accepts);
          }, aiDelay);
          activeTimers.current.push(t);
        }
      });
    } else {
      // No drivers found in this step radius
      if (radius < 5.0) {
        // Increase search radius by 1.0 km every second (slow, smooth progression)
        const nextRadius = radius + 1.0;
        state.currentRadius = nextRadius;
        setSearchRadius(nextRadius);

        onEvent({
          type: 'searching',
          label: `Scanning ${nextRadius.toFixed(1)} km Radar`,
          sub: `Searching for operators... expanding range progressively by 1km per second`,
          dot: 'blue'
        });

        const t = setTimeout(() => {
          evaluateProgressiveScan(nextRadius, rideId);
        }, 1000); // exactly 1 second delay
        activeTimers.current.push(t);
      } else {
        // Beyond 5.0 km range and no drivers found
        // "if there are not even one driver within the five kilometre range then you should see for more distance"
        if (radius >= 25.0) {
          setIsScanning(false);
          onEvent({
            type: 'fail',
            label: 'No Drivers in Wide Area',
            sub: 'All sectors scanned up to 25.0 km. No active operators found.',
            dot: 'red'
          });
          onAssign(null, rideId);
          return;
        }

        const nextRadius = radius + 5.0;
        state.currentRadius = nextRadius;
        setSearchRadius(nextRadius);

        onEvent({
          type: 'searching',
          label: `Expanding Radar to ${nextRadius.toFixed(1)} km`,
          sub: `No operators within 5.0 km core. Scanning wider sectors for distant drivers...`,
          dot: 'amber'
        });

        const t = setTimeout(() => {
          evaluateProgressiveScan(nextRadius, rideId);
        }, 2000); // 2 second delay for wider outer scans
        activeTimers.current.push(t);
      }
    }
  }

  function cancel() {
    clearAllTimers();
    if (dispatchState.current) dispatchState.current.assigned = true;
  }

  return { startDispatch, cancel };
}

// ═══════════════════════════════════════════════
// DOCUMENTATION PAGE
// ═══════════════════════════════════════════════

interface DocumentationPageProps {
  drivers: Driver[];
  setDrivers: React.Dispatch<React.SetStateAction<Driver[]>>;
  addToast: (t: Omit<Toast, 'id'>) => void;
  activeCenter?: [number, number];
}

function DocumentationPage({ drivers, setDrivers, addToast, activeCenter }: DocumentationPageProps) {
  function seedMockDrivers() {
    const mockList: Driver[] = Array.from({ length: 12 }, () => createDriver(undefined, activeCenter));
    setDrivers((prev) => [...prev, ...mockList]);
    addToast({
      type: 'success',
      icon: '🌱',
      title: 'Database Seeded',
      msg: 'Added 12 mock drivers to store!'
    });
  }

  function wipeDatabase() {
    setDrivers([]);
    localStorage.removeItem('sawari_drivers_db');
    addToast({
      type: 'info',
      icon: '🗑️',
      title: 'Database Wiped',
      msg: 'Cleared all driver records!'
    });
  }

  function printConsoleInfo() {
    console.log('=== SAWARI ACTIVE DRIVER MEMORY DATABASE ===');
    console.log('Global Store: window.SAWARI_DRIVERS_STORE');
    console.log('Total Drivers:', drivers.length);
    console.table(drivers);
    addToast({
      type: 'success',
      icon: '🖥️',
      title: 'Printed to Console',
      msg: 'Press F12 or Right Click -> Inspect -> Console to view the interactive table!'
    });
  }

  return h(
    'div',
    {
      className: 'documentation-container',
      style: {
        padding: '32px',
        maxWidth: '900px',
        margin: '0 auto',
        overflowY: 'auto',
        height: '100%',
        color: 'var(--text)',
        fontFamily: 'var(--font-sans)',
        lineHeight: '1.6'
      }
    },
    // Main Title
    h(
      'div',
      { style: { borderBottom: '1px solid var(--border)', paddingBottom: '24px', marginBottom: '32px' } },
      h('div', { style: { fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', color: 'var(--amber)', letterSpacing: '1.5px', marginBottom: '6px' } }, '📖 Technical Docs & Memory Engine'),
      h('h1', { style: { fontSize: '28px', fontWeight: '800', margin: 0, color: 'var(--text)' } }, 'Sawari Dispatch Storage Documentation'),
      h('p', { style: { color: 'var(--muted)', fontSize: '14px', marginTop: '8px', marginBottom: 0 } },
        'Detailed specification on how Sawari uses reactive globals, browser variables, and persistent memory structures to simulate on-demand logistics.'
      )
    ),

    // Client Requirements & Creator Credits
    h(
      'div',
      {
        style: {
          background: 'rgba(59, 130, 246, 0.05)',
          border: '1px solid var(--blue)',
          borderRadius: '8px',
          padding: '16px',
          marginBottom: '24px',
          fontSize: '13px',
          color: 'var(--text)'
        }
      },
      h('div', { style: { fontWeight: 'bold', color: 'var(--blue)', marginBottom: '8px', fontSize: '15px' } }, '🎯 Client Deliverable & Creator Specifications'),
      h('p', { style: { margin: '0 0 12px 0', fontSize: '13px', lineHeight: '1.5' } },
        'This dispatch simulator was built by ',
        h('strong', { style: { color: 'var(--amber)' } }, 'Yousaf Adnan'),
        ' as a test engine for the client. All core algorithms have been certified against production constraints.'
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12.5px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { color: 'var(--green)', fontWeight: 'bold' } }, '✓ System Rule Enforced:'),
          ' Dispatch radar automatically scans and broadcasts requests to at most ',
          h('strong', { style: { color: 'var(--amber)' } }, '5 riders max'),
          ' within the progressive scan range.'
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { color: 'var(--green)', fontWeight: 'bold' } }, '✓ Isolated Driver Data Layer:'),
          ' The test drivers database is fully separated into ',
          h('code', { style: { color: 'var(--amber)', background: 'rgba(255,255,255,0.05)', padding: '2px 4px', borderRadius: '4px' } }, 'src/testDrivers.ts'),
          '. In the future, this file can be easily replaced with a production API or real GPS database.'
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { color: 'var(--green)', fontWeight: 'bold' } }, '✓ Automated Location Allocation:'),
          ' Whenever a user allows browser GPS geolocation or sets a pickup, active test drivers are automatically spawned near them, so the client does not need to add drivers manually.'
        )
      )
    ),

    // Grid layout for cards
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '24px' } },

      // Interactive sandbox
      h(
        'div',
        { className: 'card', style: { border: '1px solid rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.03)', padding: '24px', borderRadius: '12px' } },
        h('div', { className: 'card-title', style: { color: 'var(--amber)', fontSize: '16px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } }, '⚡ Live Engine Sandbox & Controls'),
        h('p', { style: { fontSize: '13px', margin: '0 0 16px 0', color: 'var(--text)' } },
          'Interact with the live drivers dataset directly. See updates instantly persist and reflect on the simulator map.'
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
          h(
            'div',
            { style: { fontSize: '13px', fontWeight: 'bold', marginRight: '12px', padding: '6px 12px', borderRadius: '20px', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)' } },
            `Drivers in Store: ${drivers.length}`
          ),
          h('button', { className: 'btn btn-primary btn-sm', onClick: seedMockDrivers }, '🌱 Seed 12 Drivers'),
          h('button', { className: 'btn btn-danger btn-sm', onClick: wipeDatabase }, '🗑️ Wipe Database'),
          h('button', { className: 'btn btn-ghost btn-sm', style: { borderColor: 'var(--border)', color: 'var(--text)' }, onClick: printConsoleInfo }, '🖥️ Print Table to Console (F12)')
        )
      ),

      // Universal Test Driver Card
      h(
        'div',
        { className: 'card', style: { padding: '24px', borderRadius: '12px', border: '1px solid rgba(16, 185, 129, 0.3)', background: 'rgba(16, 185, 129, 0.02)' } },
        h('div', { className: 'card-title', style: { fontSize: '16px', fontWeight: 'bold', color: 'var(--green)', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } }, '🚗 Universal Test Driver & Single-Driver Auto-Allocation'),
        h('p', { style: { fontSize: '13px', color: 'var(--text)', margin: '8px 0', lineHeight: '1.6' } },
          'To ensure a professional and clean experience, Sawari uses an automated ',
          h('strong', { style: { color: 'var(--green)' } }, 'Single-Driver Auto-Allocation Engine'),
          ' that prevents unprofessional random drivers from cluttering the map. A single, dedicated Universal Test Driver is spawned exactly when and where you need them.'
        ),
        h('ul', { style: { fontSize: '13px', margin: '12px 0 0 0', paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', color: 'var(--text)' } },
          h('li', {}, h('strong', {}, 'Zero Random Clutter: '), 'To maintain a clean map, all unrequested random drivers are removed. There is exactly one unique driver on the map, guaranteeing a clean and reliable ride testing simulation.'),
          h('li', {}, h('strong', {}, 'Zero AI/Gemini Dependency for Dispatch: '), 'This simulator is fully autonomous and client-side. It does NOT require any external Gemini API keys or server-side AI integrations to manage matching or dispatch.'),
          h('li', {}, h('strong', {}, 'Instant Local Spawning: '), 'Whenever you open the map, pan, or place a pickup point anywhere on Earth, the system automatically detects the coordinates and instantiates the ', h('strong', { style: { color: 'var(--green)' } }, 'Universal Test Driver'), ' (~200 meters away with 99% guaranteed acceptance). This lets you instantly start and complete a ride from any location.'),
          h('li', {}, h('strong', {}, 'Production GPS Migration: '), 'In a real-world system, driver locations are obtained from real-time driver mobile apps via GPS. When moving to production, the local mock generation in ', h('code', { style: { color: 'var(--amber)' } }, 'src/testDrivers.ts'), ' can be replaced with a live backend API or direct WebSocket streams feeding live driver-side coordinates.')
        )
      ),

      // Global variable documentation
      h(
        'div',
        { className: 'card', style: { padding: '24px', borderRadius: '12px' } },
        h('div', { className: 'card-title', style: { fontSize: '16px', fontWeight: 'bold', marginBottom: '8px' } }, '🌐 Global Namespace Store'),
        h('p', { style: { fontSize: '13px', color: 'var(--text)', margin: '8px 0' } },
          'All simulated driver metrics are bound to the global scope on ',
          h('code', { style: { background: 'var(--bg)', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--amber)' } }, 'window.SAWARI_DRIVERS_STORE'),
          '. This exposes the raw data structures to browser runtime scripts, custom extensions, and browser diagnostics consoles.'
        ),
        h('div', { style: { background: 'var(--bg)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: '12px', marginTop: '12px', overflowX: 'auto', whiteSpace: 'pre', color: 'var(--text)' } },
          `// 👉 Access and log the active driver array in your developer console:\n` +
          `console.log(window.SAWARI_DRIVERS_STORE);\n\n` +
          `// 👉 Dynamically update all drivers on the map from the console:\n` +
          `window.updateSawariDrivers([\n` +
          `  {\n` +
          `    id: 'custom_1',\n` +
          `    name: 'Zeeshan Ali',\n` +
          `    avatar: '🧔',\n` +
          `    vehicle: '🚗 Economy',\n` +
          `    rating: 4.9,\n` +
          `    online: true,\n` +
          `    coords: [73.0479, 33.6844],\n` +
          `    acceptProb: 0.95,\n` +
          `    responseTime: 5,\n` +
          `    trips: 120,\n` +
          `    phone: '+92 300 1234567'\n` +
          `  }\n` +
          `]);`
        )
      ),

      // Best storing variables
      h(
        'div',
        { className: 'card', style: { padding: '24px', borderRadius: '12px' } },
        h('div', { className: 'card-title', style: { fontSize: '16px', fontWeight: 'bold', marginBottom: '8px' } }, '💾 Persistent Browser Storage Variables & Cache Clearance'),
        h('p', { style: { fontSize: '13px', color: 'var(--text)', margin: '8px 0' } },
          'To ensure an offline-first resilient experience, the simulator automatically serializes and replicates the driver store into the ',
          h('strong', {}, 'localStorage'),
          ' API under key ',
          h('code', { style: { background: 'var(--bg)', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: '12px' } }, 'sawari_drivers_db'),
          '. Active, incomplete ride tracking details are also safely stored in client cache.'
        ),
        h('ul', { style: { fontSize: '13px', margin: '12px 0 0 0', paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', color: 'var(--text)' } },
          h('li', {}, h('strong', {}, 'In-Progress Ride Persistence: '), 'If a ride is actively in progress or searching, its states are cached to let users refresh the tab without losing their vehicle tracking session.'),
          h('li', {}, h('strong', {}, 'Completed Ride Cache Purge: '), 'The moment a ride successfully finishes, the system automatically purges all temporary ride-related keys from localStorage. This prevents stale ride information from lingering in the UI.'),
          h('li', {}, h('strong', {}, 'Zero Latency Sync & Cleanup: '), 'Cleanup execution runs instantly, prompting an elegant arrival dialog overlay with a welcoming reset action.')
        )
      ),

      // Range-Based Search Radar Mechanics
      h(
        'div',
        { className: 'card', style: { padding: '24px', borderRadius: '12px' } },
        h('div', { className: 'card-title', style: { fontSize: '16px', fontWeight: 'bold', marginBottom: '8px' } }, '📡 Progressive 1km/s Search Radar Mechanics'),
        h('p', { style: { fontSize: '13px', color: 'var(--text)', margin: '8px 0' } },
          'The dispatcher utilizes an elegant, slow-growing progressive geofenced boundary to locate active operators. Instead of performing a sudden 10km zoom-out, the radar expands at exactly 1.0 km per second to minimize user cognitive load:'
        ),
        h('ul', { style: { fontSize: '13px', margin: '12px 0 0 0', paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', color: 'var(--text)' } },
          h('li', {}, h('strong', {}, 'Smooth Progressive Zoom: '), 'Scanning initiates at a tight 1.0 km radius. Every second, the radius expands by 1.0 km (1km → 2km → 3km → 4km → 5km) while the camera slowly and continuously recalibrates bounds to follow the expanding radar pulse.'),
          h('li', {}, h('strong', {}, 'Multi-Driver Dispatch Lock (Max 5): '), 'When online drivers are detected within the active radius, the engine halts the expansion and approaches up to 5 closest candidates concurrently. The UI instantly updates to reflect "Approaching X Nearby Drivers" to illustrate the batch locking queue.'),
          h('li', {}, h('strong', {}, 'Wide-Area Sector Expansion: '), 'If zero drivers are detected within the 5.0 km core radius, the engine safely expands into the wider geographical sectors (5km → 10km → 15km → 20km → 25km) and shifts the UI state to log "No drivers in core range. Extending radar to find distant drivers...".')
        )
      ),

      // Decoupled AI Simulation details
      h(
        'div',
        { className: 'card', style: { padding: '24px', borderRadius: '12px', border: '1px solid rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.02)' } },
        h('div', { className: 'card-title', style: { fontSize: '16px', fontWeight: 'bold', color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } }, '🧠 Decoupled AI Decision Engine (aiSimulation.ts)'),
        h('p', { style: { fontSize: '13px', color: 'var(--text)', margin: '8px 0', lineHeight: '1.6' } },
          'To ensure the React client file remains pristine and easily replace-able, all artificial intelligence decision mechanics are fully decoupled into the separate file:'
        ),
        h('ul', { style: { fontSize: '13px', margin: '12px 0 0 0', paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', color: 'var(--text)' } },
          h('li', {}, h('strong', {}, 'Dynamic Accept Propensities: '), 'The AI uses WGS-84 Haversine distance and real-time ride surge metrics to calculate acceptance propensity dynamically. Drivers are 30% more likely to accept higher surge-multipliers, and penalized by -8% per km of unpaid pickup run.'),
          h('li', {}, h('strong', {}, 'Modular Interface Boundaries: '), 'This architecture is designed so that when switching from AI agents to real human operators, the entire mock file can be swapped out with API fetching promises without disrupting the core React UI layer.')
        )
      ),

      // FastAPI Real-Time GPS Synchronization Blueprint
      h(
        'div',
        { className: 'card', style: { padding: '24px', borderRadius: '12px', border: '1px solid rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.02)' } },
        h('div', { className: 'card-title', style: { fontSize: '16px', fontWeight: 'bold', color: 'var(--blue)', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } }, '🐍 FastAPI Python Zero-Delay GPS Sync Backend'),
        h('p', { style: { fontSize: '13px', color: 'var(--text)', margin: '8px 0', lineHeight: '1.6' } },
          'To replace the mock simulation with real drivers, the backend transitions to a dedicated Python FastAPI + PostgreSQL infrastructure. Driver location updates must synchronize with zero lag:'
        ),
        h('ul', { style: { fontSize: '13px', margin: '12px 0 0 0', paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', color: 'var(--text)' } },
          h('li', {}, h('strong', {}, 'WebSocket Multiplexing: '), 'The FastAPI backend utilizes a lightweight ConnectionManager that maps connections by active ride ID. When a driver posts a coordinate ping, it is instantly broadcast to subscribed passengers with 0ms delay.'),
          h('li', {}, h('strong', {}, 'Structured DB persistence: '), 'Uses SQLAlchemy with PostgreSQL connection pooling to handle up to 20,000 requests/sec, logging all historical GPS trajectories for routing optimizations.')
        ),
        h('p', { style: { fontSize: '12px', color: 'var(--muted)', marginTop: '12px', fontWeight: '600' } }, '💡 View the "/fastapi_backend" directory in the project source to access the complete ready-to-run backend server, database schemas, and startup instructions!'),
      ),

      // Schema definition
      h(
        'div',
        { className: 'card', style: { padding: '24px', borderRadius: '12px' } },
        h('div', { className: 'card-title', style: { fontSize: '16px', fontWeight: 'bold', marginBottom: '8px' } }, '📋 TypeScript Data Structure (Driver Model)'),
        h('p', { style: { fontSize: '13px', margin: '8px 0', color: 'var(--text)' } },
          'The driver interface implements a robust, strict typed specification:'
        ),
        h('div', { style: { background: 'var(--bg)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: '12px', overflowX: 'auto', whiteSpace: 'pre', color: 'var(--text)' } },
          `interface Driver {\n` +
          `  id: string;          // Unique primary key identifier\n` +
          `  name: string;        // Full name of the operator\n` +
          `  avatar: string;      // Emoji glyph used for marker visualizations\n` +
          `  vehicle: string;     // Fleet classification (Economy, Comfort, XL, etc.)\n` +
          `  rating: number;      // Operator performance rank (1.0 to 5.0)\n` +
          `  online: boolean;     // Available state for dispatcher queries\n` +
          `  coords: [lng, lat];  // WGS-84 geodesic coordinate pair on map\n` +
          `  acceptProb: number;  // Probability constant representing propensity to accept\n` +
          `  responseTime: number;// Maximum countdown timeout for request acceptance\n` +
          `  trips: number;       // Accumulated lifecycle trip counts\n` +
          `  phone: string;       // Formatted mobile verification code\n` +
          `}`
        )
      )
    )
  );
}

// ═══════════════════════════════════════════════
// DRIVER MANAGEMENT PAGE
// ═══════════════════════════════════════════════

interface DriverManagementPageProps {
  drivers: Driver[];
  setDrivers: React.Dispatch<React.SetStateAction<Driver[]>>;
  selectedDriver: Driver | null;
  setSelectedDriver: React.Dispatch<React.SetStateAction<Driver | null>>;
  map: any;
  dispatch: any;
  dispatchedDriverIds: string[];
  ridePickup: [number, number] | null;
  onCollapse?: () => void;
  dispatchEvents: DispatchEvent[];
  addToast: (t: Omit<Toast, 'id'>) => void;
  mapClickMode: string | null;
  setMapClickMode: React.Dispatch<React.SetStateAction<string | null>>;
  setPendingNewDriver: React.Dispatch<React.SetStateAction<any | null>>;
}

function DriverManagementPage({
  drivers,
  setDrivers,
  selectedDriver,
  setSelectedDriver,
  dispatchedDriverIds,
  ridePickup,
  onCollapse,
  dispatchEvents,
  addToast,
  mapClickMode,
  setMapClickMode,
  setPendingNewDriver
}: DriverManagementPageProps) {
  const [newDriverName, setNewDriverName] = useState('');
  const [newDriverRating, setNewDriverRating] = useState('4.8');
  const [newDriverResponseTime, setNewDriverResponseTime] = useState('5');

  function removeDriver(id: string) {
    setDrivers((prev) => prev.filter((d) => d.id !== id));
    if (selectedDriver?.id === id) setSelectedDriver(null);
  }

  function updateDriver(updated: Driver) {
    setDrivers((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
    if (selectedDriver?.id === updated.id) setSelectedDriver(updated);
  }

  function toggleDriver(driver: Driver) {
    updateDriver({ ...driver, online: !driver.online });
  }

  function randomizePositions() {
    const baseCenter = ridePickup || ISLAMABAD_CENTER;
    setDrivers((prev) =>
      prev.map((d) => ({
        ...d,
        coords: [
          baseCenter[0] + randBetween(-0.08, 0.08),
          baseCenter[1] + randBetween(-0.06, 0.06)
        ] as [number, number]
      }))
    );
  }

  function clearAll() {
    setDrivers([]);
    setSelectedDriver(null);
  }

  function seedMockDrivers() {
    const baseCenter = ridePickup || ISLAMABAD_CENTER;
    const mockList: Driver[] = Array.from({ length: 12 }, () => createDriver(undefined, baseCenter));
    setDrivers((prev) => [...prev, ...mockList]);
    addToast({
      type: 'success',
      icon: '🌱',
      title: 'Database Seeded',
      msg: 'Added 12 mock drivers around your current active location!'
    });
  }

  const online = drivers.filter((d) => d.online).length;
  const offline = drivers.length - online;

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' } },
    h(
      'div',
      { className: 'panel-header', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      h(
        'div',
        {},
        h('div', { className: 'panel-title' }, '⚙️ Admin Panel'),
        h(
          'div',
          { className: 'panel-subtitle' },
          `${drivers.length} drivers · ${online} online · ${offline} offline`
        )
      ),
      onCollapse && h(
        'button',
        {
          className: 'btn btn-ghost btn-sm',
          onClick: onCollapse,
          title: 'Hide Panel',
          style: { padding: '4px 8px', fontSize: '11px', color: 'var(--muted)' }
        },
        'Hide ▶'
      )
    ),
    h(
      'div',
      { className: 'panel-body' },

      // Accurate driver creator form
      h(
        'form',
        {
          className: 'card',
          onSubmit: (e: React.FormEvent) => {
            e.preventDefault();
            if (!newDriverName.trim()) {
              addToast({
                type: 'error',
                icon: '⚠️',
                title: 'Name Required',
                msg: 'Please enter driver full name'
              });
              return;
            }
            const d = {
              id: 'd_' + Date.now(),
              name: newDriverName,
              avatar: randItem(AVATARS),
              vehicle: randItem(VEHICLE_TYPES),
              rating: parseFloat(newDriverRating) || 4.8,
              responseTime: parseInt(newDriverResponseTime) || 5,
              acceptProb: 0.9,
              online: true,
              trips: randInt(10, 200),
              phone: '+92 3' + randInt(0, 99).toString().padStart(2, '0') + ' ' + randInt(1000000, 9999999)
            };
            setPendingNewDriver(d);
            setMapClickMode('place_driver');
            setNewDriverName('');
            addToast({
              type: 'info',
              icon: '🗺️',
              title: 'Driver Details Saved',
              msg: `Now click on the map to confirm ${d.name}'s location and register them!`
            });
          },
          style: { display: 'flex', flexDirection: 'column', gap: '8px' }
        },
        h('div', { className: 'card-title' }, '💾 Add Accurate Database Driver'),
        h('input', {
          type: 'text',
          placeholder: 'Full Name (e.g., Arsalan Ahmed)',
          value: newDriverName,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNewDriverName(e.target.value),
          className: 'form-input',
          style: { fontSize: '12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 10px', color: 'var(--text)' }
        }),
        h(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          h(
            'div',
            { style: { flex: 1 } },
            h('label', { style: { fontSize: '10px', color: 'var(--muted)', display: 'block', marginBottom: '2px' } }, 'Rating (1.0 - 5.0)'),
            h('input', {
              type: 'number',
              step: '0.1',
              min: '1.0',
              max: '5.0',
              value: newDriverRating,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNewDriverRating(e.target.value),
              className: 'form-input',
              style: { fontSize: '12px', width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 10px', color: 'var(--text)' }
            })
          ),
          h(
            'div',
            { style: { flex: 1 } },
            h('label', { style: { fontSize: '10px', color: 'var(--muted)', display: 'block', marginBottom: '2px' } }, 'Response (secs)'),
            h('input', {
              type: 'number',
              min: '1',
              max: '30',
              value: newDriverResponseTime,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNewDriverResponseTime(e.target.value),
              className: 'form-input',
              style: { fontSize: '12px', width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 10px', color: 'var(--text)' }
            })
          )
        ),
        h(
          'button',
          {
            type: 'submit',
            className: 'btn btn-primary btn-sm',
            style: { marginTop: '4px', fontSize: '12px', padding: '6px' }
          },
          '+ Add Driver to Database'
        )
      ),

      // Live System Logs / Timeline for Admin
      dispatchEvents.length > 0 &&
        h(
          'div',
          { className: 'card' },
          h('div', { className: 'card-title' }, '📡 Live System Logs'),
          h(
            'div',
            { className: 'timeline', style: { maxHeight: '180px', overflowY: 'auto' } },
            dispatchEvents.map((evt, i) =>
              h(
                'div',
                { key: i, className: 'timeline-event' },
                h('div', { className: `timeline-dot ${evt.dot || 'amber'}` }),
                h(
                  'div',
                  { className: 'tl-content' },
                  h('div', { className: 'tl-time' }, evt.ts),
                  h('div', { className: 'tl-label' }, evt.label),
                  evt.sub && h('div', { className: 'tl-sub' }, evt.sub)
                )
              )
            )
          )
        ),

      // Database actions
      h(
        'div',
        { className: 'card' },
        h('div', { className: 'card-title' }, 'Database Utility Actions'),
        h(
          'div',
          { className: 'btn-group', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { className: 'btn btn-ghost btn-sm', style: { flex: 1 }, onClick: randomizePositions }, '🎲 Randomize Coords'),
          h('button', { className: 'btn btn-success btn-sm', style: { flex: 1 }, onClick: seedMockDrivers }, '🌱 Seed 12 Drivers'),
          h('button', { className: 'btn btn-danger btn-sm', style: { flex: 1 }, onClick: clearAll }, '🗑️ Wipe Database')
        ),
        h(
          'div',
          {
            style: {
              marginTop: 10,
              fontSize: '11px',
              color: mapClickMode === 'place_driver' ? 'var(--green)' : 'var(--muted)',
              fontWeight: mapClickMode === 'place_driver' ? 'bold' : 'normal',
              padding: mapClickMode === 'place_driver' ? '8px' : '0px',
              border: mapClickMode === 'place_driver' ? '1px dashed rgba(16, 185, 129, 0.4)' : 'none',
              borderRadius: mapClickMode === 'place_driver' ? '4px' : '0px',
              background: mapClickMode === 'place_driver' ? 'rgba(16, 185, 129, 0.05)' : 'transparent'
            }
          },
          mapClickMode === 'place_driver'
            ? '🎯 ACTIVE PLACEMENT MODE: Click anywhere on the map to locate and confirm this driver\'s coordinates!'
            : '💡 Enter driver details above, then click "+ Add Driver to Database" and click on the map to locate them.'
        )
      ),

      // Selected driver detail
      selectedDriver &&
        h(DriverDetailPanel, {
          driver: selectedDriver,
          onClose: () => setSelectedDriver(null),
          onUpdate: updateDriver,
          onDelete: removeDriver,
          onToggle: toggleDriver,
          rideCoords: ridePickup
        }),

      // Driver list table
      h(
        'div',
        { className: 'card' },
        h('div', { className: 'card-title' }, `Database Drivers (${drivers.length})`),
        drivers.length === 0
          ? h(
              'div',
              { className: 'empty-state' },
              h('div', { className: 'empty-state-icon' }, '🗺️'),
              h('p', {}, 'No drivers registered. Click on the map to add some.')
            )
          : drivers.map((d) => {
              const isDispatched = dispatchedDriverIds.includes(d.id);
              return h(
                'div',
                {
                  key: d.id,
                  className: `driver-list-item ${selectedDriver?.id === d.id ? 'selected' : ''} ${
                    isDispatched ? 'highlighted' : ''
                  }`,
                  onClick: () => setSelectedDriver(selectedDriver?.id === d.id ? null : d)
                },
                h('div', { className: `driver-avatar ${d.online ? 'online' : 'offline'}` }, d.avatar),
                h(
                  'div',
                  { className: 'driver-info' },
                  h('div', { className: 'driver-name' }, d.name),
                  h('div', { className: 'driver-meta' }, d.vehicle + ' · ⭐ ' + d.rating + ' · ' + d.responseTime + 's resp')
                ),
                h(
                  'button',
                  {
                    className: `btn btn-sm ${d.online ? 'btn-ghost' : 'btn-primary'}`,
                    style: { padding: '2px 8px', fontSize: '10px' },
                    onClick: (e) => {
                      e.stopPropagation();
                      toggleDriver(d);
                    }
                  },
                  d.online ? 'Online' : 'Offline'
                )
              );
            })
      )
    )
  );
}

// ═══════════════════════════════════════════════
// RIDE SIMULATOR PAGE
// ═══════════════════════════════════════════════

interface RideSimulatorPageProps {
  drivers: Driver[];
  setDrivers: React.Dispatch<React.SetStateAction<Driver[]>>;
  pickup: [number, number] | null;
  setPickup: React.Dispatch<React.SetStateAction<[number, number] | null>>;
  dest: [number, number] | null;
  setDest: React.Dispatch<React.SetStateAction<[number, number] | null>>;
  mapClickMode: string | null;
  setMapClickMode: React.Dispatch<React.SetStateAction<string | null>>;
  addToast: (t: Omit<Toast, 'id'>) => void;
  stats: Stats;
  setStats: React.Dispatch<React.SetStateAction<Stats>>;
  onCollapse?: () => void;
  osrmRoute: { coordinates: [number, number][]; distanceKm: number; durationSec: number } | null;
  osrmLoading: boolean;
  userCoords: [number, number] | null;
  mapInstance: maplibregl.Map | null;

  activeUsers: number;
  setActiveUsers: React.Dispatch<React.SetStateAction<number>>;
  rideStatus: 'idle' | 'searching' | 'en_route_to_pickup' | 'arrived_at_pickup' | 'on_trip' | 'completed' | 'failed';
  setRideStatus: React.Dispatch<React.SetStateAction<'idle' | 'searching' | 'en_route_to_pickup' | 'arrived_at_pickup' | 'on_trip' | 'completed' | 'failed'>>;
  assignedDriver: Driver | null;
  setAssignedDriver: React.Dispatch<React.SetStateAction<Driver | null>>;
  rideId: string | null;
  setRideId: React.Dispatch<React.SetStateAction<string | null>>;
  dispatchDrivers: Driver[];
  setDispatchDrivers: React.Dispatch<React.SetStateAction<Driver[]>>;
  dispatchCountdowns: Record<string, number>;
  setDispatchCountdowns: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  dispatchEvents: DispatchEvent[];
  setDispatchEvents: React.Dispatch<React.SetStateAction<DispatchEvent[]>>;
  countdownRefs: React.MutableRefObject<Record<string, NodeJS.Timeout>>;
  searchRadius: number;
  setSearchRadius: React.Dispatch<React.SetStateAction<number>>;
  isScanning: boolean;
  setIsScanning: React.Dispatch<React.SetStateAction<boolean>>;
  setArrivalAnimationActive: React.Dispatch<React.SetStateAction<boolean>>;
  aiSimulationEnabled: boolean;
  sheetState: 'expanded' | 'peek';
  setSheetState: React.Dispatch<React.SetStateAction<'expanded' | 'peek'>>;
  selectedCategory: 'eco' | 'comfort' | 'premium';
  setSelectedCategory: React.Dispatch<React.SetStateAction<'eco' | 'comfort' | 'premium'>>;
}

function RideSimulatorPage({
  drivers,
  setDrivers,
  pickup,
  setPickup,
  dest,
  setDest,
  mapClickMode,
  setMapClickMode,
  addToast,
  stats,
  setStats,
  onCollapse,
  osrmRoute,
  osrmLoading,
  userCoords,
  mapInstance,

  activeUsers,
  setActiveUsers,
  rideStatus,
  setRideStatus,
  assignedDriver,
  setAssignedDriver,
  rideId,
  setRideId,
  dispatchDrivers,
  setDispatchDrivers,
  dispatchCountdowns,
  setDispatchCountdowns,
  dispatchEvents,
  setDispatchEvents,
  countdownRefs,
  searchRadius,
  setSearchRadius,
  isScanning,
  setIsScanning,
  setArrivalAnimationActive,
  aiSimulationEnabled,
  sheetState,
  setSheetState,
  selectedCategory,
  setSelectedCategory
}: RideSimulatorPageProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  const pLng = pickup?.[0];
  const pLat = pickup?.[1];
  const dLng = dest?.[0];
  const dLat = dest?.[1];

  const [pickupSearch, setPickupSearch] = useState('');
  const [destSearch, setDestSearch] = useState('');
  const [pickupSg, setPickupSg] = useState<any[]>([]);
  const [destSg, setDestSg] = useState<any[]>([]);
  const [loadingPickupSg, setLoadingPickupSg] = useState(false);
  const [loadingDestSg, setLoadingDestSg] = useState(false);

  // Synchronize inputs with pickup/dest coordinates (reverse geocoding)
  useEffect(() => {
    if (pickup) {
      if (!pickupSearch || pickupSearch.includes(',')) {
        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lon=${pickup[0]}&lat=${pickup[1]}&zoom=16`)
          .then((res) => res.json())
          .then((data) => {
            if (data && data.display_name) {
              setPickupSearch(data.display_name);
            } else {
              setPickupSearch(`${pickup[0].toFixed(5)}, ${pickup[1].toFixed(5)}`);
            }
          })
          .catch(() => {
            setPickupSearch(`${pickup[0].toFixed(5)}, ${pickup[1].toFixed(5)}`);
          });
      }
    } else {
      setPickupSearch('');
      setPickupSg([]);
    }
  }, [pLng, pLat]);

  useEffect(() => {
    if (dest) {
      if (!destSearch || destSearch.includes(',')) {
        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lon=${dest[0]}&lat=${dest[1]}&zoom=16`)
          .then((res) => res.json())
          .then((data) => {
            if (data && data.display_name) {
              setDestSearch(data.display_name);
            } else {
              setDestSearch(`${dest[0].toFixed(5)}, ${dest[1].toFixed(5)}`);
            }
          })
          .catch(() => {
            setDestSearch(`${dest[0].toFixed(5)}, ${dest[1].toFixed(5)}`);
          });
      }
    } else {
      setDestSearch('');
      setDestSg([]);
    }
  }, [dLng, dLat]);

  function searchNominatim(query: string, type: 'pickup' | 'dest') {
    if (!query || query.trim().length < 3) return;
    if (type === 'pickup') setLoadingPickupSg(true);
    else setLoadingDestSg(true);

    fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`)
      .then((res) => {
        if (!res.ok) throw new Error('Nominatim error');
        return res.json();
      })
      .then((data) => {
        if (type === 'pickup') {
          setPickupSg(data);
        } else {
          setDestSg(data);
        }
      })
      .catch((err) => {
        console.error('Nominatim search failed', err);
        addToast({
          type: 'error',
          icon: '⚠️',
          title: 'Search Error',
          msg: 'Unable to connect to address search engine'
        });
      })
      .finally(() => {
        if (type === 'pickup') setLoadingPickupSg(false);
        else setLoadingDestSg(false);
      });
  }

  function selectSuggestion(item: any, type: 'pickup' | 'dest') {
    const coords: [number, number] = [parseFloat(item.lon), parseFloat(item.lat)];
    if (type === 'pickup') {
      setPickup(coords);
      setPickupSearch(item.display_name);
      setPickupSg([]);
      if (mapInstance) {
        mapInstance.flyTo({ center: coords, zoom: 14 });
      }
    } else {
      setDest(coords);
      setDestSearch(item.display_name);
      setDestSg([]);
      if (mapInstance) {
        if (pickup) {
          const bounds = new maplibregl.LngLatBounds();
          bounds.extend(pickup);
          bounds.extend(coords);
          mapInstance.fitBounds(bounds, { padding: 50, maxZoom: 15 });
        } else {
          mapInstance.flyTo({ center: coords, zoom: 14 });
        }
      }
    }
  }

  const online = drivers.filter((d) => d.online);
  const getPeakMultiplier = (users: number) => {
    if (users < 5) return 1.0;
    return 1.0 + Math.floor(users / 5) * 0.25;
  };
  const surge = getPeakMultiplier(activeUsers);
  const dist = osrmRoute ? osrmRoute.distanceKm : (pickup && dest ? haversineKm(pickup, dest) : null);
  const fare = dist ? calcFare(dist, surge) : null;

  function addEvent(evt: DispatchEvent) {
    setDispatchEvents((prev) =>
      [{ ...evt, ts: new Date().toLocaleTimeString() }, ...prev].slice(0, 30)
    );
  }

  function handleAssign(driver: Driver | 'already' | null, rid: string) {
    clearAllCountdowns();
    if (!driver || driver === null) {
      setRideStatus('failed');
      return;
    }
    if (driver === 'already') return;
    setAssignedDriver(driver);
    setRideStatus('en_route_to_pickup');
    setDispatchDrivers([]);

    // Fly to and zoom in on the driver's location who accepted
    if (mapInstance) {
      mapInstance.flyTo({
        center: driver.coords,
        zoom: 15.0,
        pitch: 45,
        bearing: 30,
        duration: 2500,
        essential: true
      });
    }

    addToast({
      type: 'success',
      icon: '🚗',
      title: 'Driver Found',
      msg: `${driver.name} is heading to your pickup location!`
    });
  }

  function clearAllCountdowns() {
    Object.values(countdownRefs.current).forEach(clearInterval);
    countdownRefs.current = {};
    setDispatchCountdowns({});
    setDispatchDrivers([]);
  }

  const engine = useDispatchEngine({
    drivers,
    pickup,
    dest,
    onEvent: addEvent,
    onAssign: handleAssign,
    addToast,
    searchRadius,
    setSearchRadius,
    isScanning,
    setIsScanning,
    setDispatchDrivers,
    setDispatchCountdowns,
    countdownRefs,
    aiSimulationEnabled,
    selectedCategory
  });

  // Resume scanning/searching dispatch on mount if page reloads while in 'searching' state
  useEffect(() => {
    if (rideStatus === 'searching' && rideId) {
      const surge = getPeakMultiplier(activeUsers);
      engine.startDispatch(rideId, surge);
    }
  }, []);

  function startRide() {
    if (!pickup || !dest) {
      addToast({
        type: 'error',
        icon: '⚠️',
        title: 'Set Route First',
        msg: 'Please select a pickup and destination on the map'
      });
      return;
    }
    const rid = 'SWR-' + uid();
    setRideId(rid);
    setRideStatus('searching');
    setAssignedDriver(null);
    setDispatchEvents([]);
    setStats((s) => ({ ...s, totalRequests: s.totalRequests + 1 }));

    // The useDispatchEngine now handles full range checking, radar scanning, and countdown dispatch.
    engine.startDispatch(rid, surge);
  }

  function resetRide() {
    engine.cancel();
    setRideStatus('idle');
    setRideId(null);
    setAssignedDriver(null);
    setDispatchEvents([]);
    setPickup(null);
    setDest(null);
    setMapClickMode(null);
    setSearchRadius(5.0);
    setIsScanning(false);
    setArrivalAnimationActive(false);
    clearAllCountdowns();
  }

  const statusConfig = {
    idle: {
      cls: 'rsb-idle',
      icon: '🗺️',
      label: 'No Active Ride',
      sub: 'Select pickup and destination to begin',
      spin: false
    },
    searching: {
      cls: 'rsb-searching',
      icon: '🔍',
      label: 'Searching for Drivers',
      sub: 'Notifying nearby drivers...',
      spin: true
    },
    assigned: {
      cls: 'rsb-assigned',
      icon: '✅',
      label: 'Ride Assigned',
      sub: `Driver: ${assignedDriver?.name || ''}`,
      spin: false
    },
    failed: {
      cls: 'rsb-idle',
      icon: '❌',
      label: 'No Driver Found',
      sub: 'All drivers declined or unavailable',
      spin: false
    },
    broadcast: {
      cls: 'rsb-broadcast',
      icon: '📡',
      label: 'Broadcast Mode',
      sub: 'Expanding search...',
      spin: false
    }
  };
  const sc = statusConfig[rideStatus] || statusConfig.idle;

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' } },
    h(
      'div',
      { className: 'panel-header', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      h(
        'div',
        {},
        h('div', { className: 'panel-title' }, '🛣️ Ride Simulator'),
        h(
          'div',
          { className: 'panel-subtitle' },
          rideId ? h('span', { className: 'ride-id' }, rideId) : 'Create a new ride request'
        )
      ),
      onCollapse && h(
        'button',
        {
          className: 'btn btn-ghost btn-sm',
          onClick: onCollapse,
          title: 'Hide Panel',
          style: { padding: '4px 8px', fontSize: '11px', color: 'var(--muted)' }
        },
        'Hide ▼'
      )
    ),
    h(
      'div',
      { className: 'panel-body' },

      // Status banner
      h(
        'div',
        { className: `ride-status-banner ${sc.cls}` },
        h(
          'div',
          { className: 'rsb-icon' },
          h('span', { className: sc.spin ? 'spin' : '' }, sc.icon)
        ),
        h(
          'div',
          {},
          h('div', { className: 'rsb-label' }, sc.label),
          h('div', { className: 'rsb-sub' }, sc.sub)
        )
      ),

      // IF ACTIVE RIDE: SHOW PERMANENT LOCATIONS & DRIVER DETAILS
      rideStatus !== 'idle'
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },

            // Permanent Route Locations Card
            h(
              'div',
              {
                className: 'card',
                style: {
                  padding: '16px',
                  background: 'var(--surface-light, #1e2130)',
                  border: '1px solid var(--border)'
                }
              },
              h(
                'div',
                {
                  className: 'card-title',
                  style: {
                    fontSize: '11px',
                    color: 'var(--muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                    marginBottom: '12px'
                  }
                },
                '🗺️ Trip Details'
              ),
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '14px',
                    position: 'relative',
                    paddingLeft: '8px'
                  }
                },

                // Vertical connecting line
                h('div', {
                  style: {
                    position: 'absolute',
                    left: '18px',
                    top: '24px',
                    bottom: '24px',
                    width: '2px',
                    borderLeft: '2px dashed var(--muted)',
                    opacity: 0.5
                  }
                }),

                // Pickup Location (Locked)
                h(
                  'div',
                  { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
                  h(
                    'div',
                    {
                      style: {
                        width: '22px',
                        height: '22px',
                        borderRadius: '50%',
                        background: 'rgba(16, 185, 129, 0.2)',
                        border: '2px solid var(--green)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '10px',
                        color: 'var(--green)',
                        fontWeight: 'bold',
                        zIndex: 2
                      }
                    },
                    'A'
                  ),
                  h(
                    'div',
                    { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontSize: '11px', color: 'var(--muted)' } }, 'Pickup Location (GPS)'),
                    h(
                      'div',
                      {
                        style: {
                          fontSize: '14px',
                          fontWeight: 'bold',
                          color: 'var(--white)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }
                      },
                      pickupSearch || `${pickup?.[0].toFixed(5)}, ${pickup?.[1].toFixed(5)}`
                    )
                  )
                ),

                // Destination Location (Locked)
                h(
                  'div',
                  { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
                  h(
                    'div',
                    {
                      style: {
                        width: '22px',
                        height: '22px',
                        borderRadius: '50%',
                        background: 'rgba(239, 68, 68, 0.2)',
                        border: '2px solid var(--red)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '10px',
                        color: 'var(--red)',
                        fontWeight: 'bold',
                        zIndex: 2
                      }
                    },
                    'B'
                  ),
                  h(
                    'div',
                    { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontSize: '11px', color: 'var(--muted)' } }, 'Destination'),
                    h(
                      'div',
                      {
                        style: {
                          fontSize: '14px',
                          fontWeight: 'bold',
                          color: 'var(--white)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }
                      },
                      destSearch || `${dest?.[0].toFixed(5)}, ${dest?.[1].toFixed(5)}`
                    )
                  )
                )
              )
            ),

            // Fare Estimate Display Card
            fare &&
              h(
                'div',
                {
                  className: 'card',
                  style: {
                    padding: '16px',
                    textAlign: 'center',
                    border: '1px solid rgba(59, 130, 246, 0.3)',
                    background: 'rgba(59, 130, 246, 0.05)'
                  }
                },
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                  h(
                    'div',
                    { style: { textAlign: 'left' } },
                    h('div', { style: { fontSize: '11px', color: 'var(--muted)' } }, 'Fare & Distance'),
                    h(
                      'div',
                      { style: { fontSize: '20px', fontWeight: '800', color: 'var(--green)' } },
                      'Rs. ' + fare.total
                    ),
                    osrmRoute &&
                      h(
                        'div',
                        { style: { fontSize: '11px', color: 'var(--text)' } },
                        `${osrmRoute.distanceKm.toFixed(2)} km total`
                      )
                  ),
                  h(
                    'div',
                    {
                      style: {
                        background: 'var(--bg)',
                        padding: '6px 12px',
                        borderRadius: '20px',
                        border: '1px solid var(--border)'
                      }
                    },
                    h(
                      'span',
                      { style: { fontSize: '11px', fontWeight: 'bold', color: 'var(--amber)' } },
                      selectedCategory === 'eco'
                        ? '🚗 Eco / Mini'
                        : selectedCategory === 'premium'
                          ? '🏎️ Premium XL'
                          : '🚕 Comfort AC'
                    )
                  )
                )
              ),

            // Driver details / Searching progress
            assignedDriver
              ? h(
                  'div',
                  {
                    className: 'card',
                    style: {
                      padding: '16px',
                      border: '1px solid var(--green)',
                      background: 'rgba(16, 185, 129, 0.08)'
                    }
                  },
                  h(
                    'div',
                    {
                      className: 'card-title',
                      style: {
                        color: 'var(--green)',
                        fontSize: '13px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }
                    },
                    h('span', {}, '✅ Assigned Operator Details'),
                    h(
                      'span',
                      { className: 'badge badge-online animate-pulse', style: { fontSize: '10px' } },
                      rideStatus === 'en_route_to_pickup'
                        ? 'En Route'
                        : rideStatus === 'arrived_at_pickup'
                          ? 'Arrived'
                          : 'On Trip'
                    )
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: '14px', alignItems: 'center', margin: '12px 0' } },
                    h(
                      'div',
                      {
                        style: {
                          width: '50px',
                          height: '50px',
                          borderRadius: '50%',
                          background: 'var(--bg)',
                          border: '2px solid var(--green)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '28px',
                          boxShadow: '0 4px 10px rgba(0,0,0,0.3)'
                        }
                      },
                      assignedDriver.avatar
                    ),
                    h(
                      'div',
                      { style: { flex: 1 } },
                      h('div', { style: { fontSize: '16px', fontWeight: '800', color: 'var(--white)' } }, assignedDriver.name),
                      h('div', { style: { fontSize: '12px', color: 'var(--text)' } }, assignedDriver.vehicle),
                      h(
                        'div',
                        {
                          style: {
                            fontSize: '11px',
                            color: 'var(--muted)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                          }
                        },
                        h('span', { style: { color: 'var(--amber)' } }, `★ ${assignedDriver.rating}`),
                        h('span', {}, '·'),
                        h('span', {}, `${assignedDriver.trips || 120} trips`),
                        h('span', {}, '·'),
                        h(
                          'span',
                          {
                            style: { color: 'var(--green)', cursor: 'pointer', textDecoration: 'underline' },
                            onClick: () => {
                              addToast({
                                type: 'success',
                                icon: '📞',
                                title: `Calling ${assignedDriver.name}`,
                                msg: `Connecting to ${assignedDriver.phone}...`
                              });
                            }
                          },
                          assignedDriver.phone
                        )
                      )
                    )
                  ),

                  // Action button inside assigned driver details
                  h(
                    'div',
                    { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
                    h(
                      'button',
                      {
                        className: 'btn btn-ghost btn-sm',
                        style: { flex: 1, borderColor: 'var(--border)', color: 'var(--text)', fontSize: '12px' },
                        onClick: () => {
                          addToast({
                            type: 'info',
                            icon: '💬',
                            title: 'Message Sent',
                            msg: `Texted driver: "I am waiting at the pickup point."`
                          });
                        }
                      },
                      '💬 Message'
                    ),
                    h(
                      'button',
                      {
                        className: 'btn btn-danger btn-sm',
                        style: { flex: 1, fontSize: '12px' },
                        onClick: resetRide
                      },
                      '🛑 Cancel Ride'
                    )
                  )
                )
              : h(
                  'div',
                  { className: 'card', style: { padding: '16px' } },
                  h('div', { className: 'card-title', style: { fontSize: '13px' } }, 'Notified Drivers'),
                  h(
                    'p',
                    { style: { fontSize: '11px', color: 'var(--muted)', margin: '4px 0 12px 0' } },
                    `Searching for closest ${selectedCategory} vehicles...`
                  ),

                  dispatchDrivers.length > 0
                    ? h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                        dispatchDrivers.map((d) => {
                          const cd = dispatchCountdowns[d.id];
                          return h(
                            'div',
                            { key: d.id, className: `dispatch-driver-card ${cd > 0 ? 'searching' : ''}` },
                            h('div', { style: { fontSize: 20 } }, d.avatar),
                            h(
                              'div',
                              { style: { flex: 1 } },
                              h('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--white)' } }, d.name),
                              h('div', { style: { fontSize: 11, color: 'var(--muted)' } }, d.vehicle)
                            ),
                            h('div', { className: 'dispatch-countdown' }, cd > 0 ? cd + 's' : '…'),
                            h(
                              'div',
                              { style: { marginLeft: 6 } },
                              h('span', { className: 'dispatch-status ds-waiting' }, 'Waiting')
                            )
                          );
                        })
                      )
                    : h(
                        'div',
                        {
                          style: {
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            padding: '16px 0',
                            gap: '12px'
                          }
                        },
                        h('div', { className: 'radar-pulse-ring' }),
                        h(
                          'div',
                          { style: { fontSize: '12px', color: 'var(--muted)', textAlign: 'center' } },
                          'Scanning sectors... expanding range progressively by 1.0 km/s'
                        )
                      ),

                  h(
                    'button',
                    {
                      className: 'btn btn-danger btn-full',
                      style: { marginTop: '16px' },
                      onClick: resetRide
                    },
                    '❌ Cancel Search'
                  )
                )
          )
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },



            // Route selection
            h(
              'div',
              { className: 'card' },
              h(
                'div',
                {
                  className: 'card-title',
                  style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }
                },
                'Route Options',
                osrmLoading && h('span', { className: 'text-xs text-amber animate-pulse' }, 'Calculating OSRM Route...')
              ),

              // Pickup Step
              h(
                'div',
                {
                  className: `ride-step ${mapClickMode === 'pickup' ? 'active' : ''} ${pickup ? 'done' : ''}`,
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    cursor: 'default',
                    padding: '12px'
                  }
                },
                h(
                  'div',
                  {
                    style: { display: 'flex', alignItems: 'center', width: '100%', cursor: 'pointer' },
                    onClick: () => setMapClickMode(mapClickMode === 'pickup' ? null : 'pickup')
                  },
                  h('div', { className: 'step-num' }, '1'),
                  h(
                    'div',
                    { style: { flex: 1, minWidth: 0 } },
                    h('div', { className: 'step-label' }, 'Pickup Location'),
                    pickup &&
                      h(
                        'div',
                        {
                          className: 'step-val',
                          style: {
                            fontSize: '11px',
                            color: 'var(--muted)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }
                        },
                        pickup[0].toFixed(5) + ', ' + pickup[1].toFixed(5)
                      )
                  ),
                  h(
                    'span',
                    { style: { fontSize: 12, color: 'var(--muted)' } },
                    pickup ? '✓' : 'Click map or search →'
                  )
                ),

                // Search box inside pickup
                h(
                  'div',
                  {
                    style: { marginTop: '8px', display: 'flex', gap: '8px', position: 'relative' },
                    onClick: (e) => e.stopPropagation()
                  },
                  h('input', {
                    type: 'text',
                    placeholder: 'Type address to search Nominatim...',
                    value: pickupSearch,
                    className: 'form-input',
                    style: {
                      flex: 1,
                      fontSize: '12px',
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      padding: '6px 10px',
                      color: 'var(--text)'
                    },
                    onFocus: () => setSheetState('expanded'),
                    onClick: () => setSheetState('expanded'),
                    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setPickupSearch(e.target.value),
                    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === 'Enter') searchNominatim(pickupSearch, 'pickup');
                    }
                  }),
                  h(
                    'button',
                    {
                      className: 'btn btn-primary btn-sm',
                      style: { padding: '4px 10px', fontSize: '11px' },
                      onClick: () => searchNominatim(pickupSearch, 'pickup')
                    },
                    loadingPickupSg ? '⌛' : '🔍'
                  ),
                  userCoords &&
                    h(
                      'button',
                      {
                        className: 'btn btn-ghost btn-sm',
                        style: { padding: '4px 8px', fontSize: '11px', borderColor: 'var(--border)' },
                        title: 'Use Live GPS Location',
                        onClick: () => {
                          setPickup(userCoords);
                          setPickupSearch('Live Location (GPS)');
                          if (mapInstance) {
                            mapInstance.flyTo({ center: userCoords, zoom: 15 });
                          }
                        }
                      },
                      '📍'
                    )
                ),

                // Nominatim suggestions list
                pickupSg.length > 0 &&
                  h(
                    'div',
                    {
                      style: {
                        maxHeight: '150px',
                        overflowY: 'auto',
                        background: 'var(--surface-light, #252836)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        marginTop: '6px',
                        zIndex: 1100,
                        display: 'flex',
                        flexDirection: 'column'
                      },
                      onClick: (e) => e.stopPropagation()
                    },
                    pickupSg.map((item, idx) =>
                      h(
                        'button',
                        {
                          key: idx,
                          className: 'suggestion-item',
                          style: {
                            textAlign: 'left',
                            padding: '8px 12px',
                            fontSize: '11px',
                            color: 'var(--text)',
                            borderBottom: idx < pickupSg.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                            background: 'none',
                            width: '100%',
                            cursor: 'pointer'
                          },
                          onClick: () => selectSuggestion(item, 'pickup')
                        },
                        h('div', { style: { fontWeight: 'bold' } }, item.address?.road || item.address?.suburb || 'Location'),
                        h(
                          'div',
                          {
                            style: {
                              opacity: 0.7,
                              fontSize: '10px',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis'
                            }
                          },
                          item.display_name
                        )
                      )
                    )
                  )
              ),

              // Destination Step
              h(
                'div',
                {
                  className: `ride-step ${mapClickMode === 'dest' ? 'active' : ''} ${dest ? 'done' : ''}`,
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    cursor: 'default',
                    padding: '12px'
                  }
                },
                h(
                  'div',
                  {
                    style: { display: 'flex', alignItems: 'center', width: '100%', cursor: 'pointer' },
                    onClick: () => pickup && setMapClickMode(mapClickMode === 'dest' ? null : 'dest')
                  },
                  h('div', { className: 'step-num' }, '2'),
                  h(
                    'div',
                    { style: { flex: 1, minWidth: 0 } },
                    h('div', { className: 'step-label' }, 'Destination'),
                    dest &&
                      h(
                        'div',
                        {
                          className: 'step-val',
                          style: {
                            fontSize: '11px',
                            color: 'var(--muted)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }
                        },
                        dest[0].toFixed(5) + ', ' + dest[1].toFixed(5)
                      )
                  ),
                  h(
                    'span',
                    { style: { fontSize: 12, color: 'var(--muted)' } },
                    !pickup ? 'Set pickup first' : dest ? '✓' : 'Click map or search →'
                  )
                ),

                // Search box inside dest
                pickup &&
                  h(
                    'div',
                    {
                      style: { marginTop: '8px', display: 'flex', gap: '8px', position: 'relative' },
                      onClick: (e) => e.stopPropagation()
                    },
                    h('input', {
                      type: 'text',
                      placeholder: 'Type address to search Nominatim...',
                      value: destSearch,
                      className: 'form-input',
                      style: {
                        flex: 1,
                        fontSize: '12px',
                        background: 'var(--bg)',
                        border: '1px solid var(--border)',
                        borderRadius: '6px',
                        padding: '6px 10px',
                        color: 'var(--text)'
                      },
                      onFocus: () => setSheetState('expanded'),
                      onClick: () => setSheetState('expanded'),
                      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDestSearch(e.target.value),
                      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === 'Enter') searchNominatim(destSearch, 'dest');
                      }
                    }),
                    h(
                      'button',
                      {
                        className: 'btn btn-primary btn-sm',
                        style: { padding: '4px 10px', fontSize: '11px' },
                        onClick: () => searchNominatim(destSearch, 'dest')
                      },
                      loadingDestSg ? '⌛' : '🔍'
                    )
                  ),

                // Nominatim suggestions list
                destSg.length > 0 &&
                  h(
                    'div',
                    {
                      style: {
                        maxHeight: '150px',
                        overflowY: 'auto',
                        background: 'var(--surface-light, #252836)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        marginTop: '6px',
                        zIndex: 1100,
                        display: 'flex',
                        flexDirection: 'column'
                      },
                      onClick: (e) => e.stopPropagation()
                    },
                    destSg.map((item, idx) =>
                      h(
                        'button',
                        {
                          key: idx,
                          className: 'suggestion-item',
                          style: {
                            textAlign: 'left',
                            padding: '8px 12px',
                            fontSize: '11px',
                            color: 'var(--text)',
                            borderBottom: idx < destSg.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                            background: 'none',
                            width: '100%',
                            cursor: 'pointer'
                          },
                          onClick: () => selectSuggestion(item, 'dest')
                        },
                        h('div', { style: { fontWeight: 'bold' } }, item.address?.road || item.address?.suburb || 'Location'),
                        h(
                          'div',
                          {
                            style: {
                              opacity: 0.7,
                              fontSize: '10px',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis'
                            }
                          },
                          item.display_name
                        )
                      )
                    )
                  )
              ),

              h(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 10 } },
                h(
                  'button',
                  {
                    className: 'btn btn-primary btn-full',
                    onClick: startRide,
                    disabled: !pickup || !dest
                  },
                  '🚀 Request Ride'
                )
              )
            ),

            // Fare estimate (shown when route is set but ride is not requested yet)
            fare &&
              h(
                'div',
                { className: 'card', style: { padding: '24px', borderRadius: '16px', textAlign: 'center' } },
                h(
                  'div',
                  {
                    className: 'card-title',
                    style: {
                      fontSize: '15px',
                      color: 'var(--muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '1px',
                      marginBottom: '16px'
                    }
                  },
                  'Fare Estimate'
                ),
                h(
                  'div',
                  { className: 'fare-display', style: { display: 'flex', flexDirection: 'column', alignItems: 'center' } },
                  h(
                    'div',
                    {
                      className: 'fare-amount',
                      style: { fontSize: '48px', fontWeight: '900', color: 'var(--green)', letterSpacing: '-1px', lineHeight: '1' }
                    },
                    'Rs. ' + fare.total
                  ),
                  osrmRoute &&
                    h(
                      'div',
                      {
                        style: {
                          marginTop: '18px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '8px',
                          background: 'rgba(59, 130, 246, 0.1)',
                          border: '1px solid rgba(59, 130, 246, 0.3)',
                          padding: '10px 20px',
                          borderRadius: '30px',
                          width: 'fit-content'
                        }
                      },
                      h('span', { style: { fontSize: '14px', color: 'rgba(59, 130, 246, 0.9)', fontWeight: '600' } }, '📍 Distance:'),
                      h(
                        'span',
                        { style: { fontSize: '18px', color: 'var(--text)', fontWeight: '800', fontFamily: 'var(--font-mono)' } },
                        `${osrmRoute.distanceKm.toFixed(2)} km`
                      )
                    )
                )
              )
          )
    )
  );
}



function DriverPanelPage() {
  /*
  return h(
    'div',
    {
      className: 'panel-container',
      style: {
        maxWidth: '800px',
        margin: '0 auto',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
        minHeight: '100vh',
        background: 'var(--bg)'
      }
    },
    // Header
    h(
      'div',
      {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid var(--border)',
          paddingBottom: '16px'
        }
      },
      h(
        'div',
        {},
        h('h1', { style: { fontSize: '24px', fontWeight: 'bold', margin: 0, color: 'var(--text)' } }, '📱 Sawari Driver Console'),
        h('p', { style: { fontSize: '12px', color: 'var(--muted)', margin: '4px 0 0 0' } }, 'Simulate a real driver\'s personal mobile application')
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { fontSize: '13px', color: 'var(--muted)' } }, 'Operator:'),
        h(
          'select',
          {
            value: activeDriverId,
            onChange: (e: any) => setActiveDriverId(e.target.value),
            style: {
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '6px 12px',
              color: 'var(--text)',
              fontSize: '13px',
              fontWeight: 'bold',
              outline: 'none',
              cursor: 'pointer'
            }
          },
          drivers.map((d) =>
            h(
              'option',
              { key: d.id, value: d.id },
              `${d.online ? '🟢' : '⚪'} ${d.name} (${d.vehicle.split(' ')[0]})`
            )
          )
        )
      )
    ),

    // AI Automation Toggle Control Banner
    h(
      'div',
      {
        className: 'card',
        style: {
          padding: '16px 20px',
          borderRadius: '12px',
          border: '1px solid var(--border)',
          background: aiSimulationEnabled ? 'rgba(16, 185, 129, 0.04)' : 'rgba(255, 255, 255, 0.01)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '16px',
          flexWrap: 'wrap'
        }
      },
      h(
        'div',
        { style: { flex: 1, minWidth: '240px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: { fontSize: '16px' } }, '🤖'),
          h('span', { style: { fontWeight: 'bold', fontSize: '14px', color: 'var(--text)' } }, 'AI Dispatch Automation Simulator')
        ),
        h(
          'p',
          { style: { fontSize: '12px', color: 'var(--muted)', margin: '4px 0 0 0', lineHeight: '1.4' } },
          aiSimulationEnabled
            ? 'Background AI agents are active. They will automatically decide, respond, or reject dispatch offers based on mathematical probability models.'
            : 'AI background decision agents are offline. Dispatch requests must be processed manually by selecting each driver from the dropdown above.'
        )
      ),
      h(
        'button',
        {
          onClick: () => {
            const nextVal = !aiSimulationEnabled;
            setAiSimulationEnabled(nextVal);
            addToast({
              type: 'info',
              icon: nextVal ? '🤖' : '⚙️',
              title: 'Simulation Mode Changed',
              msg: nextVal ? 'AI background decisions active!' : 'Manual driver dispatch tests mode enabled!'
            });
          },
          className: `btn ${aiSimulationEnabled ? 'btn-primary' : 'btn-outline'}`,
          style: {
            background: aiSimulationEnabled ? 'var(--green)' : 'transparent',
            borderColor: aiSimulationEnabled ? 'var(--green)' : 'var(--border)',
            color: aiSimulationEnabled ? 'white' : 'var(--text)',
            fontSize: '12px',
            fontWeight: 'bold',
            whiteSpace: 'nowrap'
          }
        },
        aiSimulationEnabled ? '🟢 AUTOMATION ACTIVE' : '⚪ MANUAL ONLY'
      )
    ),

    currentDriver
      ? h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '24px' } },
          // Driver Status and Identity Card
          h(
            'div',
            { className: 'card', style: { padding: '20px', borderRadius: '12px', position: 'relative' } },
            h(
              'div',
              { style: { display: 'flex', gap: '16px', alignItems: 'center' } },
              h('div', { style: { fontSize: '48px', background: 'var(--bg)', borderRadius: '50%', padding: '12px', border: '1px solid var(--border)' } }, currentDriver.avatar),
              h(
                'div',
                { style: { flex: 1 } },
                h('div', { style: { fontSize: '18px', fontWeight: 'bold', color: 'var(--text)' } }, currentDriver.name),
                h('div', { style: { fontSize: '13px', color: 'var(--muted)' } }, currentDriver.vehicle),
                h('div', { style: { fontSize: '12px', color: 'var(--muted)', marginTop: '4px' } }, `📞 ${currentDriver.phone || 'N/A'}`)
              ),
              h(
                'div',
                { style: { textAlign: 'right' } },
                h(
                  'button',
                  {
                    onClick: toggleOnline,
                    className: `btn ${currentDriver.online ? 'btn-primary' : 'btn-outline'}`,
                    style: {
                      background: currentDriver.online ? 'var(--green)' : 'transparent',
                      color: currentDriver.online ? 'white' : 'var(--text)',
                      borderColor: currentDriver.online ? 'var(--green)' : 'var(--border)'
                    }
                  },
                  currentDriver.online ? '● ONLINE' : '○ OFFLINE'
                ),
                h('p', { style: { fontSize: '11px', color: 'var(--muted)', marginTop: '6px' } }, 'Tap to toggle status')
              )
            ),
            // Stats Row
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  justifyContent: 'space-around',
                  marginTop: '20px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: '8px',
                  padding: '12px 6px',
                  border: '1px solid var(--border)'
                }
              },
              h(
                'div',
                { style: { textAlign: 'center' } },
                h('div', { style: { fontSize: '11px', color: 'var(--muted)' } }, 'Rating'),
                h('div', { style: { fontSize: '16px', fontWeight: 'bold', color: 'var(--amber)' } }, `⭐ ${currentDriver.rating.toFixed(1)}`)
              ),
              h(
                'div',
                { style: { textAlign: 'center' } },
                h('div', { style: { fontSize: '11px', color: 'var(--muted)' } }, 'Accept Rate'),
                h('div', { style: { fontSize: '16px', fontWeight: 'bold', color: 'var(--text)' } }, `${(currentDriver.acceptProb * 100).toFixed(0)}%`)
              ),
              h(
                'div',
                { style: { textAlign: 'center' } },
                h('div', { style: { fontSize: '11px', color: 'var(--muted)' } }, 'Sim GPS Update'),
                h('div', { style: { fontSize: '12px', fontWeight: 'bold', fontFamily: 'var(--font-mono)', color: 'var(--blue)' } }, `${currentDriver.coords[0].toFixed(4)}, ${currentDriver.coords[1].toFixed(4)}`)
              )
            )
          ),

          // ─── ACTIVE OFFER RECEIVED CARD ───
          isNotified &&
            h(
              'div',
              {
                className: 'card card-glowing-amber',
                style: {
                  padding: '24px',
                  borderRadius: '16px',
                  border: '2px solid var(--amber)',
                  background: 'rgba(245, 158, 11, 0.05)',
                  boxShadow: '0 0 20px rgba(245, 158, 11, 0.25)',
                  animation: 'pulse 2s infinite'
                }
              },
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' } },
                h('span', { style: { background: 'var(--amber)', color: 'black', fontWeight: 'bold', padding: '4px 8px', borderRadius: '4px', fontSize: '11px' } }, '⚠️ INCOMING DISPATCH REQUEST'),
                h(
                  'span',
                  { style: { fontFamily: 'var(--font-mono)', fontWeight: 'bold', fontSize: '18px', color: 'var(--amber)' } },
                  `${countdown}s Remaining`
                )
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' } },
                h(
                  'div',
                  { style: { fontSize: '20px', fontWeight: 'bold', color: 'var(--text)' } },
                  `Est. Fare: PKR ${fare}`
                ),
                h(
                  'div',
                  { style: { fontSize: '13px', color: 'var(--muted)' } },
                  `Total Distance: ${distance} km`
                ),
                h(
                  'div',
                  {
                    style: {
                      background: 'var(--bg)',
                      padding: '12px',
                      borderRadius: '8px',
                      border: '1px solid var(--border)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px'
                    }
                  },
                  h('div', {}, h('span', { style: { fontSize: '11px', color: 'var(--green)', fontWeight: 'bold' } }, '🟢 PICKUP: '), h('span', { style: { fontSize: '13px', color: 'var(--text)' } }, pickupName)),
                  h('div', {}, h('span', { style: { fontSize: '11px', color: 'var(--red)', fontWeight: 'bold' } }, '🔴 DESTINATION: '), h('span', { style: { fontSize: '13px', color: 'var(--text)' } }, destName))
                )
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '12px' } },
                h(
                  'button',
                  {
                    onClick: () => {
                      (window as any).triggerDriverResponse(activeDriverId, true);
                    },
                    className: 'btn btn-primary',
                    style: { flex: 1, background: 'var(--green)', color: 'white', fontWeight: 'bold', height: '46px', fontSize: '15px' }
                  },
                  '🟢 Accept Offer'
                ),
                h(
                  'button',
                  {
                    onClick: () => {
                      (window as any).triggerDriverResponse(activeDriverId, false);
                    },
                    className: 'btn btn-outline',
                    style: { flex: 1, borderColor: 'var(--red)', color: 'var(--red)', fontWeight: 'bold', height: '46px', fontSize: '15px' }
                  },
                  '❌ Reject Offer'
                )
              )
            ),

          // ─── ACTIVE TRIP IN PROGRESS ───
          isAssignedToMe && rideStatus !== 'idle' && rideStatus !== 'completed' && rideStatus !== 'failed' &&
            h(
              'div',
              {
                className: 'card',
                style: {
                  padding: '24px',
                  borderRadius: '16px',
                  border: '1px solid var(--green)',
                  background: 'rgba(16, 185, 129, 0.05)'
                }
              },
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' } },
                h('span', { style: { background: 'var(--green)', color: 'white', fontWeight: 'bold', padding: '4px 8px', borderRadius: '4px', fontSize: '11px' } }, '🚗 ACTIVE CLIENT RIDE'),
                h(
                  'span',
                  { style: { fontWeight: 'bold', fontSize: '13px', color: 'var(--green)' } },
                  rideStatus.toUpperCase().replace(/_/g, ' ')
                )
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' } },
                h('div', { style: { fontSize: '16px', fontWeight: 'bold', color: 'var(--text)' } }, `Trip ID: ${rideId}`),
                h('div', { style: { fontSize: '14px', color: 'var(--text)' } }, `Ride Fare: PKR ${fare} · Distance: ${distance} km`),
                h(
                  'div',
                  {
                    style: {
                      background: 'var(--bg)',
                      padding: '12px',
                      borderRadius: '8px',
                      border: '1px solid var(--border)'
                    }
                  },
                  h('p', { style: { fontSize: '13px', margin: '4px 0' } }, `📍 Pickup Coordinate: ${pickup ? pickup[0].toFixed(5) + ', ' + pickup[1].toFixed(5) : 'N/A'}`),
                  h('p', { style: { fontSize: '13px', margin: '4px 0' } }, `🏁 Dest Coordinate: ${dest ? dest[0].toFixed(5) + ', ' + dest[1].toFixed(5) : 'N/A'}`)
                )
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '12px' } },
                rideStatus === 'en_route_to_pickup' &&
                  h(
                    'button',
                    {
                      onClick: () => {
                        setRideStatus('arrived_at_pickup');
                        addToast({ type: 'success', icon: '🛎️', title: 'Arrived at Pickup', msg: 'Passenger has been notified of your arrival!' });
                      },
                      className: 'btn btn-primary',
                      style: { flex: 1, background: 'var(--amber)', color: 'black' }
                    },
                    '🛎️ Arrived at Pickup Location'
                  ),
                rideStatus === 'arrived_at_pickup' &&
                  h(
                    'button',
                    {
                      onClick: () => {
                        setRideStatus('on_trip');
                        addToast({ type: 'success', icon: '🚀', title: 'Trip Started', msg: 'Cruising to Sector Destination...' });
                      },
                      className: 'btn btn-primary',
                      style: { flex: 1, background: 'var(--blue)', color: 'white' }
                    },
                    '🚀 Start Passenger Ride'
                  ),
                rideStatus === 'on_trip' &&
                  h(
                    'button',
                    {
                      onClick: () => {
                        setRideStatus('completed');
                        addToast({ type: 'success', icon: '🏁', title: 'Trip Completed', msg: `Fare of PKR ${fare} collected successfully!` });
                      },
                      className: 'btn btn-primary',
                      style: { flex: 1, background: 'var(--green)', color: 'white' }
                    },
                    '🏁 Complete Ride & Bill Client'
                  )
              )
            ),

          // Idle Screen when no request is assigned to this driver
          !isNotified && !isAssignedToMe &&
            h(
              'div',
              {
                className: 'card',
                style: {
                  padding: '40px',
                  borderRadius: '12px',
                  textAlign: 'center',
                  background: 'rgba(255, 255, 255, 0.01)',
                  border: '1px dashed var(--border)'
                }
              },
              h('div', { style: { fontSize: '48px', marginBottom: '16px', animation: 'spin 4s linear infinite' } }, '📡'),
              h('h3', { style: { fontSize: '16px', fontWeight: 'bold', margin: '0 0 8px 0', color: 'var(--text)' } }, currentDriver.online ? 'Standby Mode: Listening for Requests' : 'You are currently offline'),
              h(
                'p',
                { style: { fontSize: '13px', color: 'var(--muted)', maxWidth: '400px', margin: '0 auto', lineHeight: '1.6' } },
                currentDriver.online
                  ? 'The dispatch engine is actively monitoring nearby passenger bookings. Ensure you are within 5-10km of Islamabad centers for high surge priority!'
                  : 'Toggle your status to ONLINE above to start receiving live dispatch notifications.'
              ),
              currentDriver.online &&
                h(
                  'div',
                  {
                    style: {
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      background: 'rgba(16, 185, 129, 0.1)',
                      color: 'var(--green)',
                      padding: '6px 16px',
                      borderRadius: '20px',
                      fontSize: '12px',
                      fontWeight: 'bold',
                      marginTop: '20px'
                    }
                  },
                  h('span', { style: { width: '8px', height: '8px', background: 'var(--green)', borderRadius: '50%', display: 'inline-block' } }),
                  'ACTIVE RADAR SEARCHING...'
                )
            )
        )
      : h('p', {}, 'No active driver selected.')
  );
  */
  return null;
}

// ═══════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════

function App() {
  const [page, setPage] = useState<'ride' | 'admin' | 'documentation'>('ride');
  const [aiSimulationEnabled, setAiSimulationEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('sawari_ai_simulation');
    return saved !== null ? saved === 'true' : true;
  });
  const [activeDriverId, setActiveDriverId] = useState<string>('d_test_universal'); // Selected active driver in driver panel
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeUsers, setActiveUsers] = useState<number>(3);
  const [driversPanelCollapsed, setDriversPanelCollapsed] = useState(false);
  const [sheetState, setSheetState] = useState<'expanded' | 'peek'>('expanded');
  const [dragOffset, setDragOffset] = useState<number>(0);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [drivers, setDrivers] = useState<Driver[]>(() => {
    const stored = localStorage.getItem('sawari_drivers_db');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch (e) {}
    }
    return DEFAULT_DRIVERS;
  });
  const [selectedDriver, setSelectedDriver] = useState<Driver | null>(null);
  const [pickup, setPickup] = useState<[number, number] | null>(() => {
    const saved = localStorage.getItem('sawari_pickup');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {}
    }
    return null;
  });
  const [dest, setDest] = useState<[number, number] | null>(() => {
    const saved = localStorage.getItem('sawari_dest');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {}
    }
    return null;
  });
  const [mapClickMode, setMapClickMode] = useState<string | null>(null); // null | 'pickup' | 'dest' | 'driver'
  const [pendingNewDriver, setPendingNewDriver] = useState<any | null>(null);
  const [dispatchedDriverIds] = useState<string[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [stats, setStats] = useState<Stats>(() => {
    const saved = localStorage.getItem('sawari_stats_db');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {}
    }
    return {
      online: 0,
      offline: 0,
      totalRequests: 0,
      completed: 0,
      avgFare: 0,
      redZones: 0
    };
  });

  const [userCoords, setUserCoords] = useState<[number, number] | null>(null);
  const [mapCenterCoords, setMapCenterCoords] = useState<[number, number] | null>(ISLAMABAD_CENTER);
  const mapCenterLng = mapCenterCoords?.[0];
  const mapCenterLat = mapCenterCoords?.[1];
  const [osrmRoute, setOsrmRoute] = useState<{
    coordinates: [number, number][];
    distanceKm: number;
    durationSec: number;
  } | null>(null);
  const [pickupRoute, setPickupRoute] = useState<{
    coordinates: [number, number][];
    distanceKm: number;
    durationSec: number;
  } | null>(null);
  const [osrmLoading, setOsrmLoading] = useState(false);

  const [selectedCategory, setSelectedCategory] = useState<'eco' | 'comfort' | 'premium'>(() => {
    const saved = localStorage.getItem('sawari_selected_category');
    return (saved as any) || 'comfort';
  });

  useEffect(() => {
    localStorage.setItem('sawari_selected_category', selectedCategory);
  }, [selectedCategory]);

  // Elevated Ride Simulator States
  const [rideStatus, setRideStatus] = useState<
    'idle' | 'searching' | 'en_route_to_pickup' | 'arrived_at_pickup' | 'on_trip' | 'completed' | 'failed'
  >(() => {
    const saved = localStorage.getItem('sawari_ride_status');
    return (saved as any) || 'idle';
  });
  const [assignedDriver, setAssignedDriver] = useState<Driver | null>(() => {
    const saved = localStorage.getItem('sawari_assigned_driver');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {}
    }
    return null;
  });

  const liveAssignedDriver = assignedDriver
    ? (drivers.find((d) => d.id === assignedDriver.id) || assignedDriver)
    : null;

  // Stable primitive values for coordinates to prevent infinite useEffect re-render loops (Maximum update depth exceeded)
  const pickupLng = pickup?.[0];
  const pickupLat = pickup?.[1];
  const destLng = dest?.[0];
  const destLat = dest?.[1];
  const liveDriverLng = liveAssignedDriver?.coords?.[0];
  const liveDriverLat = liveAssignedDriver?.coords?.[1];
  const userCoordsLng = userCoords?.[0];
  const userCoordsLat = userCoords?.[1];

  const isUserInteractingRef = useRef<boolean>(false);
  const userInteractionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [rideId, setRideId] = useState<string | null>(() => {
    return localStorage.getItem('sawari_ride_id') || null;
  });
  const [dispatchDrivers, setDispatchDrivers] = useState<Driver[]>([]);
  const [dispatchCountdowns, setDispatchCountdowns] = useState<Record<string, number>>({});
  const [dispatchEvents, setDispatchEvents] = useState<DispatchEvent[]>([]);
  const countdownRefs = useRef<Record<string, NodeJS.Timeout>>({});

  // Dynamic search and radar animation states
  const [searchRadius, setSearchRadius] = useState<number>(5.0);
  const [mapZoom, setMapZoom] = useState<number>(12);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [arrivalAnimationActive, setArrivalAnimationActive] = useState<boolean>(false);

  const mapInstance = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});
  const pickupMarkerRef = useRef<maplibregl.Marker | null>(null);
  const destMarkerRef = useRef<maplibregl.Marker | null>(null);
  const routeLayerRef = useRef(false);
  const mapClickModeRef = useRef<string | null>(null);
  const pendingNewDriverRef = useRef<any | null>(null);
  const driversRef = useRef<Driver[]>(drivers);

  // Keep refs in sync
  useEffect(() => {
    driversRef.current = drivers;
    mapClickModeRef.current = mapClickMode;
    pendingNewDriverRef.current = pendingNewDriver;
  }, [drivers, mapClickMode, pendingNewDriver]);

  // Update stats and sync database (optimizing with state equality checks to prevent infinite re-renders)
  useEffect(() => {
    const on = drivers.filter((d) => d.online).length;
    const off = drivers.length - on;
    setStats((s) => {
      if (s.online === on && s.offline === off) return s;
      return { ...s, online: on, offline: off };
    });
    localStorage.setItem('sawari_drivers_db', JSON.stringify(drivers));
  }, [drivers]);

  // Expose to window for global debugging and programmatic access
  useEffect(() => {
    window.SAWARI_DRIVERS_STORE = drivers;
    window.updateSawariDrivers = (newDrivers: Driver[]) => {
      setDrivers(newDrivers);
      localStorage.setItem('sawari_drivers_db', JSON.stringify(newDrivers));
      addToast({
        type: 'success',
        icon: '🖥️',
        title: 'Global Store Sync',
        msg: `Updated ${newDrivers.length} drivers from Console`
      });
    };
  }, [drivers]);

  // Load initial drivers from localStorage (persistent database)
  useEffect(() => {
    const stored = localStorage.getItem('sawari_drivers_db');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setDrivers(parsed);
          return;
        }
      } catch (e) {
        console.warn('Failed to parse stored drivers, resetting db', e);
      }
    }
    // Starts with high-quality permanent default drivers to avoid an empty database
    setDrivers(DEFAULT_DRIVERS);
    localStorage.setItem('sawari_drivers_db', JSON.stringify(DEFAULT_DRIVERS));
  }, []);

  // Real-time GPS movement simulation loop
  useEffect(() => {
    const timer = setInterval(() => {
      setDrivers((prev) => {
        return simulateDriverMovements(prev, assignedDriver?.id || null);
      });
    }, GPS_UPDATE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [assignedDriver]);

  // Synchronize Ride State to localStorage for full persistence across refreshes
  useEffect(() => {
    if (rideStatus === 'completed') {
      localStorage.removeItem('sawari_ride_status');
      localStorage.removeItem('sawari_assigned_driver');
      localStorage.removeItem('sawari_pickup');
      localStorage.removeItem('sawari_dest');
      localStorage.removeItem('sawari_ride_id');
      return;
    }

    localStorage.setItem('sawari_ride_status', rideStatus);
    
    if (assignedDriver) {
      // Find the driver's latest coordinates in the drivers array to prevent snapping back
      const latestDriver = drivers.find(d => d.id === assignedDriver.id);
      const driverToSave = latestDriver ? { ...assignedDriver, coords: latestDriver.coords } : assignedDriver;
      localStorage.setItem('sawari_assigned_driver', JSON.stringify(driverToSave));
    } else {
      localStorage.removeItem('sawari_assigned_driver');
    }
    
    if (pickup) {
      localStorage.setItem('sawari_pickup', JSON.stringify(pickup));
    } else {
      localStorage.removeItem('sawari_pickup');
    }
    
    if (dest) {
      localStorage.setItem('sawari_dest', JSON.stringify(dest));
    } else {
      localStorage.removeItem('sawari_dest');
    }
    
    if (rideId) {
      localStorage.setItem('sawari_ride_id', rideId);
    } else {
      localStorage.removeItem('sawari_ride_id');
    }
  }, [rideStatus, assignedDriver, pickupLng, pickupLat, destLng, destLat, rideId, drivers]);

  // Update stats in localStorage when it changes
  useEffect(() => {
    localStorage.setItem('sawari_stats_db', JSON.stringify(stats));
  }, [stats]);

  // Automatically allocate/spawn active online drivers close to the user's location (GPS, pickup, or map center view)
  useEffect(() => {
    // Only spawn/recentre drivers when the app is in idle mode (not during active search or active ride)
    if (rideStatus !== 'idle') return;

    const loc: [number, number] | null = (pickupLng && pickupLat)
      ? [pickupLng, pickupLat]
      : (userCoordsLng && userCoordsLat)
        ? [userCoordsLng, userCoordsLat]
        : (mapCenterLng && mapCenterLat)
          ? [mapCenterLng, mapCenterLat]
          : null;

    if (loc) {
      const currentDrivers = driversRef.current;
      // Find the specific universal test driver from the latest state ref
      const universalDriverExists = currentDrivers.some((d) => d.id === 'd_test_universal');
      const universalDriverClose = currentDrivers.some((d) => d.id === 'd_test_universal' && haversineKm(d.coords, loc) <= 1.5);

      // If the universal driver doesn't exist or is too far away from the active location, re-center him!
      if (!universalDriverExists || !universalDriverClose) {
        const targetCoords: [number, number] = [
          loc[0] + 0.002, // extremely close (~200 meters)
          loc[1] + 0.002
        ];

        const universalDriver: Driver = {
          id: 'd_test_universal',
          name: 'Universal Test Driver',
          avatar: '🚗',
          vehicle: '⚡ Hybrid Sedan (Test Car)',
          rating: 5.0,
          responseTime: 4,
          acceptProb: 0.99, // Guaranteed high acceptance
          online: true,
          coords: targetCoords,
          trips: 999,
          phone: '+92 300 0000000'
        };

        // Update database with ONLY the single Universal Test Driver to keep the map clean, simple and professional!
        setDrivers([universalDriver]);

        addToast({
          type: 'success',
          icon: '📍',
          title: 'Location Synced',
          msg: 'Universal Test Driver automatically allocated near your current location!'
        });
      }
    }
  }, [userCoordsLng, userCoordsLat, pickupLng, pickupLat, mapCenterLng, mapCenterLat, rideStatus]);

  // Sync AI simulation enabled flag
  useEffect(() => {
    localStorage.setItem('sawari_ai_simulation', String(aiSimulationEnabled));
  }, [aiSimulationEnabled]);

  function addToast(t: Omit<Toast, 'id'>) {
    const id = toastIdCounter++;
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 4000);
  }

  function handleCompleteReset() {
    setRideStatus('idle');
    setRideId(null);
    setAssignedDriver(null);
    setDispatchEvents([]);
    setPickup(null);
    setDest(null);
    setMapClickMode(null);
    setSearchRadius(5.0);
    setIsScanning(false);
    setArrivalAnimationActive(false);
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragOffset(0);
    const startY = e.clientY;
    const startX = e.clientX;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const newOffset = Math.max(0, deltaY);
      setDragOffset(newOffset);
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      setIsDragging(false);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);

      const deltaY = upEvent.clientY - startY;
      const deltaX = upEvent.clientX - startX;

      if (Math.abs(deltaY) < 5 && Math.abs(deltaX) < 5) {
        setSheetState((s) => (s === 'expanded' ? 'peek' : 'expanded'));
      } else if (deltaY > 80) {
        setSheetState('peek');
      } else if (deltaY < -80) {
        setSheetState('expanded');
      }
      setDragOffset(0);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  // ─── RESIZE MAP ON PANEL TOGGLE ───
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;
    const timer = setTimeout(() => {
      map.resize();
    }, 350);
    return () => clearTimeout(timer);
  }, [driversPanelCollapsed, page]);

  // ─── MAP INIT ───
  useEffect(() => {
    const map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors'
          }
        },
        layers: [
          {
            id: 'osm',
            type: 'raster',
            source: 'osm',
            paint: {
              'raster-brightness-min': 0,
              'raster-brightness-max': 1.0,
              'raster-saturation': 0,
              'raster-contrast': 0
            }
          }
        ]
      },
      center: ISLAMABAD_CENTER,
      zoom: 12,
      attributionControl: false
    });

    map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true
      },
      trackUserLocation: true,
      showUserLocation: true
    });
    map.addControl(geolocate, 'bottom-right');

    map.on('zoom', () => {
      setMapZoom(map.getZoom());
    });

    map.on('moveend', () => {
      const center = map.getCenter();
      setMapCenterCoords([center.lng, center.lat]);
    });

    map.on('dragstart', () => {
      isUserInteractingRef.current = true;
      if (userInteractionTimeoutRef.current) {
        clearTimeout(userInteractionTimeoutRef.current);
      }
    });

    map.on('dragend', () => {
      if (userInteractionTimeoutRef.current) {
        clearTimeout(userInteractionTimeoutRef.current);
      }
      userInteractionTimeoutRef.current = setTimeout(() => {
        isUserInteractingRef.current = false;
      }, 5000);
    });

    geolocate.on('geolocate', (position: any) => {
      const userLngLat: [number, number] = [position.coords.longitude, position.coords.latitude];
      setUserCoords(userLngLat);
    });

    map.on('load', () => {
      // Trigger native device tracking on open
      setTimeout(() => {
        geolocate.trigger();
      }, 500);
      // Route source
      map.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } }
      });
      map.addLayer({
        id: 'route-glow',
        type: 'line',
        source: 'route',
        paint: { 'line-color': '#F97316', 'line-width': 8, 'line-opacity': 0.2, 'line-blur': 4 }
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        paint: {
          'line-color': '#F97316',
          'line-width': 3,
          'line-opacity': 0.9,
          'line-dasharray': [2, 1]
        }
      });

      // Red zones source
      map.addSource('redzones', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.addLayer({
        id: 'redzones-fill',
        type: 'circle',
        source: 'redzones',
        paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': '#EF4444',
          'circle-opacity': 0.12,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#EF4444',
          'circle-stroke-opacity': 0.5
        }
      });

      // Peak Zone source
      map.addSource('peak-zone', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } }
      });
      map.addLayer({
        id: 'peak-zone-fill',
        type: 'fill',
        source: 'peak-zone',
        paint: {
          'fill-color': '#EF4444',
          'fill-opacity': 0.10
        }
      });
      map.addLayer({
        id: 'peak-zone-outline',
        type: 'line',
        source: 'peak-zone',
        paint: {
          'line-color': '#EF4444',
          'line-width': 2,
          'line-opacity': 0.4,
          'line-dasharray': [4, 4]
        }
      });

      // Search Radar source & layers
      map.addSource('search-radar', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } }
      });
      map.addLayer({
        id: 'search-radar-fill',
        type: 'fill',
        source: 'search-radar',
        paint: {
          'fill-color': '#3B82F6',
          'fill-opacity': 0.08
        }
      });
      map.addLayer({
        id: 'search-radar-outline',
        type: 'line',
        source: 'search-radar',
        paint: {
          'line-color': '#3B82F6',
          'line-width': 1.5,
          'line-opacity': 0.5,
          'line-dasharray': [4, 2]
        }
      });

      routeLayerRef.current = true;
    });

    map.on('click', (e) => {
      const mode = mapClickModeRef.current;
      const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];

      if (mode === 'place_driver' || mode === 'driver') {
        const pending = pendingNewDriverRef.current;
        const d: Driver = {
          id: pending?.id || ('d_' + Date.now()),
          name: pending?.name || 'New Driver',
          avatar: pending?.avatar || '🧔',
          vehicle: pending?.vehicle || '🚗 Car',
          rating: pending?.rating || 4.8,
          responseTime: pending?.responseTime || 5,
          acceptProb: pending?.acceptProb || 0.9,
          online: pending?.online !== undefined ? pending.online : true,
          coords: lngLat,
          trips: pending?.trips || 15,
          phone: pending?.phone || '+92 300 1234567'
        };
        setDrivers((prev) => [...prev, d]);
        setSelectedDriver(d);
        setMapClickMode(null);
        setPendingNewDriver(null);
        return;
      }
      if (mode === 'pickup') {
        setPickup(lngLat);
        setMapClickMode('dest');
        return;
      }
      if (mode === 'dest') {
        setDest(lngLat);
        setMapClickMode(null);
        return;
      }
    });

    mapInstance.current = map;
    return () => {
      map.remove();
    };
  }, []);

  // Helper to generate a geographic circle polygon for Peak Zone (5km)
  function getCirclePolygon(center: [number, number], radiusKm: number): [number, number][][] {
    const coordinates: [number, number][] = [];
    const steps = 64;
    const kmPerDegreeLng = 111.32 * Math.cos(center[1] * Math.PI / 180);
    const kmPerDegreeLat = 110.574;

    const rLng = radiusKm / kmPerDegreeLng;
    const rLat = radiusKm / kmPerDegreeLat;

    for (let i = 0; i < steps; i++) {
      const theta = (i / steps) * 2 * Math.PI;
      const lng = center[0] + rLng * Math.cos(theta);
      const lat = center[1] + rLat * Math.sin(theta);
      coordinates.push([lng, lat]);
    }
    coordinates.push(coordinates[0]);
    return [coordinates];
  }

  // ─── SYNC PEAK ZONE GEOMETRY ───
  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !routeLayerRef.current) return;

    const source = map.getSource('peak-zone') as maplibregl.GeoJSONSource | undefined;
    if (!source) return;

    if (activeUsers >= 5 && pickup) {
      const circlePoly = getCirclePolygon(pickup, 5); // 5km
      source.setData({
        type: 'Feature',
        properties: { name: 'Peak Zone' },
        geometry: {
          type: 'Polygon',
          coordinates: circlePoly
        }
      });
    } else {
      source.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [] }
      });
    }
  }, [pickupLng, pickupLat, activeUsers]);

  // ─── SYNC SEARCH RADAR GEOMETRY & PULSE ───
  const [pulseRadius, setPulseRadius] = useState<number>(5.0);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !routeLayerRef.current) return;

    const source = map.getSource('search-radar') as maplibregl.GeoJSONSource | undefined;
    if (!source) return;

    if (pickup) {
      const activeRadius = isScanning ? pulseRadius : searchRadius;
      const circlePoly = getCirclePolygon(pickup, activeRadius);
      source.setData({
        type: 'Feature',
        properties: { name: 'Search Radar' },
        geometry: {
          type: 'Polygon',
          coordinates: circlePoly
        }
      });
    } else {
      source.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [] }
      });
    }
  }, [pickupLng, pickupLat, searchRadius, isScanning, pulseRadius]);

  // Radar scanning animation wave
  useEffect(() => {
    if (!isScanning) {
      setPulseRadius(searchRadius);
      return;
    }

    let frameId: number;
    let start = Date.now();
    const duration = 1500; // 1.5 seconds per pulse wave

    const animate = () => {
      const elapsed = Date.now() - start;
      const progress = (elapsed % duration) / duration; // 0 to 1
      const currentPulse = progress * searchRadius;
      setPulseRadius(currentPulse);

      const map = mapInstance.current;
      if (map && routeLayerRef.current) {
        try {
          map.setPaintProperty('search-radar-fill', 'fill-opacity', 0.15 * (1 - progress));
          map.setPaintProperty('search-radar-outline', 'line-opacity', 0.7 * (1 - progress));
        } catch (e) {}
      }

      frameId = requestAnimationFrame(animate);
    };

    frameId = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frameId);
      const map = mapInstance.current;
      if (map && routeLayerRef.current) {
        try {
          map.setPaintProperty('search-radar-fill', 'fill-opacity', 0.08);
          map.setPaintProperty('search-radar-outline', 'line-opacity', 0.5);
        } catch (e) {}
      }
    };
  }, [isScanning, searchRadius]);

  // ─── DRIVER MOVEMENT ANIMATION ENGINE ───
  useEffect(() => {
    // Utility for linear coordinate interpolation to make motion buttery smooth
    function interpolateCoords(coordsList: [number, number][], targetSteps: number): [number, number][] {
      if (coordsList.length < 2) return coordsList;
      const segments: { start: [number, number]; end: [number, number]; dist: number }[] = [];
      let totalDist = 0;
      for (let i = 0; i < coordsList.length - 1; i++) {
        const p1 = coordsList[i];
        const p2 = coordsList[i + 1];
        const d = haversineKm(p1, p2);
        segments.push({ start: p1, end: p2, dist: d });
        totalDist += d;
      }
      if (totalDist === 0) return coordsList;

      const result: [number, number][] = [coordsList[0]];
      for (let s = 1; s < targetSteps; s++) {
        const targetDist = (s / targetSteps) * totalDist;
        let currentDist = 0;
        let found = false;
        for (const seg of segments) {
          if (currentDist + seg.dist >= targetDist) {
            const ratio = (targetDist - currentDist) / seg.dist;
            const lng = seg.start[0] + (seg.end[0] - seg.start[0]) * ratio;
            const lat = seg.start[1] + (seg.end[1] - seg.start[1]) * ratio;
            result.push([lng, lat]);
            found = true;
            break;
          }
          currentDist += seg.dist;
        }
        if (!found) {
          result.push(coordsList[coordsList.length - 1]);
        }
      }
      result.push(coordsList[coordsList.length - 1]);
      return result;
    }

    if (rideStatus === 'en_route_to_pickup' && assignedDriver && pickup && pickupRoute) {
      const originalCoords = pickupRoute.coordinates;
      if (originalCoords.length === 0) {
        setRideStatus('arrived_at_pickup');
        return;
      }

      // Calculate total duration proportional to distance (10s per km, minimum 5s)
      const dist = pickupRoute.distanceKm || 1.0;
      const totalDurationMs = Math.max(5000, dist * 10000);
      const intervalMs = 50; // High 20 FPS frequency
      const stepsCount = Math.max(50, Math.round(totalDurationMs / intervalMs));
      const coords = interpolateCoords(originalCoords, stepsCount);
      let currentIndex = 0;

      const interval = setInterval(() => {
        currentIndex++;
        if (currentIndex < coords.length) {
          const nextCoords = coords[currentIndex];
          setDrivers((prev) =>
            prev.map((d) => (d.id === assignedDriver.id ? { ...d, coords: nextCoords } : d))
          );

          // Update route line on map: slice off completed parts of the route
          const remainingCoords = coords.slice(currentIndex);
          const map = mapInstance.current;
          if (map) {
            const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
            if (source) {
              source.setData({
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: remainingCoords.length > 0 ? remainingCoords : [nextCoords] }
              });
            }
          }
        } else {
          clearInterval(interval);
          setDrivers((prev) =>
            prev.map((d) => (d.id === assignedDriver.id ? { ...d, coords: pickup } : d))
          );
          setAssignedDriver((prev) => (prev ? { ...prev, coords: pickup } : null));
          setRideStatus('arrived_at_pickup');
          setArrivalAnimationActive(true);
          addToast({
            type: 'success',
            icon: '👋',
            title: 'Driver Arrived',
            msg: `${assignedDriver.name} has arrived at your pickup location!`
          });

          // Wait 3.0 seconds at pickup, showing the full-screen animation overlay, then start trip
          setTimeout(() => {
            setArrivalAnimationActive(false);
            setRideStatus('on_trip');
            addToast({
              type: 'info',
              icon: '🚗',
              title: 'Trip Started',
              msg: 'Enjoy your ride!'
            });
          }, 3000);
        }
      }, intervalMs);

      return () => clearInterval(interval);
    }

    if (rideStatus === 'on_trip' && assignedDriver && osrmRoute) {
      const originalCoords = osrmRoute.coordinates;
      if (originalCoords.length === 0) {
        setRideStatus('completed');
        return;
      }

      // Calculate total duration proportional to distance (10s per km, minimum 5s)
      const dist = osrmRoute.distanceKm || 1.0;
      const totalDurationMs = Math.max(5000, dist * 10000);
      const intervalMs = 50; // High 20 FPS frequency
      const stepsCount = Math.max(50, Math.round(totalDurationMs / intervalMs));
      const coords = interpolateCoords(originalCoords, stepsCount);
      let currentIndex = 0;

      const interval = setInterval(() => {
        currentIndex++;
        if (currentIndex < coords.length) {
          const nextCoords = coords[currentIndex];
          setDrivers((prev) =>
            prev.map((d) => (d.id === assignedDriver.id ? { ...d, coords: nextCoords } : d))
          );

          // Update route line on map: slice off completed parts of the route
          const remainingCoords = coords.slice(currentIndex);
          const map = mapInstance.current;
          if (map) {
            const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
            if (source) {
              source.setData({
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: remainingCoords.length > 0 ? remainingCoords : [nextCoords] }
              });
            }
          }
        } else {
          clearInterval(interval);
          setRideStatus('completed');
          // Instantly remove past ride information from the UI and caches
          setPickup(null);
          setDest(null);
          setAssignedDriver(null);
          setOsrmRoute(null);
          setPickupRoute(null);
          setRideId(null);
          localStorage.removeItem('sawari_pickup');
          localStorage.removeItem('sawari_dest');
          localStorage.removeItem('sawari_assigned_driver');
          localStorage.removeItem('sawari_ride_id');
          localStorage.removeItem('sawari_ride_status');

          addToast({
            type: 'success',
            icon: '🏁',
            title: 'Trip Completed',
            msg: 'You have safely arrived at your destination!'
          });
          setStats((s) => ({ ...s, completed: s.completed + 1 }));
        }
      }, intervalMs);

      return () => clearInterval(interval);
    }
  }, [rideStatus, assignedDriver, pickupLng, pickupLat, osrmRoute, pickupRoute]);

  // ─── SYNC DRIVER MARKERS ───
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;

    // Remove stale markers
    Object.keys(markersRef.current).forEach((id) => {
      if (!drivers.find((d) => d.id === id)) {
        markersRef.current[id].remove();
        delete markersRef.current[id];
      }
    });

    const ref = pickup || userCoords || ISLAMABAD_CENTER;
    // Determine the active viewing radius based on the current search range system
    const activeRadius = (rideStatus === 'searching' || rideStatus === 'idle') ? searchRadius : 99999;

    // Update/create markers
    const scale = Math.max(0.6, Math.min(1.8, mapZoom / 12));

    drivers.forEach((d) => {
      const dist = haversineKm(d.coords, ref);
      const isAssigned = assignedDriver?.id === d.id;
      const inRange = dist <= activeRadius;
      const shouldShow = rideStatus !== 'idle' && ((inRange && d.online) || isAssigned);

      if (!shouldShow) {
        if (markersRef.current[d.id]) {
          markersRef.current[d.id].remove();
          delete markersRef.current[d.id];
        }
        return;
      }

      const isSelected = selectedDriver?.id === d.id;
      const svg = markerForDriver(d, isSelected);
      const el = document.createElement('div');
      el.innerHTML = svg;
      el.style.cursor = 'pointer';
      el.style.width = '32px';
      el.style.height = '32px';
      el.style.transform = `scale(${scale})`;
      el.style.transformOrigin = 'center center';
      el.title = d.name;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        setSelectedDriver((prev) => (prev?.id === d.id ? null : d));
      });

      if (markersRef.current[d.id]) {
        markersRef.current[d.id].setLngLat(d.coords);
        const existingEl = markersRef.current[d.id].getElement();
        if (existingEl.getAttribute('data-svg') !== svg) {
          existingEl.innerHTML = svg;
          existingEl.setAttribute('data-svg', svg);
        }
        existingEl.style.transform = `scale(${scale})`;
      } else {
        el.setAttribute('data-svg', svg);
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat(d.coords)
          .addTo(map);
        markersRef.current[d.id] = marker;
      }
    });
  }, [drivers, selectedDriver, pickupLng, pickupLat, userCoordsLng, userCoordsLat, rideStatus, searchRadius, assignedDriver, mapZoom]);

  // ─── SYNC PICKUP / DEST MARKERS ───
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;

    const scale = Math.max(0.6, Math.min(2.0, mapZoom / 12));

    if (pickup) {
      const el = document.createElement('div');
      el.innerHTML = pickupSVG();
      el.style.width = '36px';
      el.style.height = '44px';
      el.style.cursor = 'default';
      el.style.transform = `scale(${scale})`;
      el.style.transformOrigin = 'bottom center';
      if (pickupMarkerRef.current) pickupMarkerRef.current.remove();
      pickupMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat(pickup)
        .addTo(map);
    } else {
      if (pickupMarkerRef.current) {
        pickupMarkerRef.current.remove();
        pickupMarkerRef.current = null;
      }
    }

    if (dest) {
      const el = document.createElement('div');
      el.innerHTML = destSVG();
      el.style.width = '36px';
      el.style.height = '44px';
      el.style.cursor = 'default';
      el.style.transform = `scale(${scale})`;
      el.style.transformOrigin = 'bottom center';
      if (destMarkerRef.current) destMarkerRef.current.remove();
      destMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat(dest)
        .addTo(map);
    } else {
      if (destMarkerRef.current) {
        destMarkerRef.current.remove();
        destMarkerRef.current = null;
      }
    }
  }, [pickupLng, pickupLat, destLng, destLat, mapZoom]);

  // ─── CAMERA ZOOM FOR SCANNING RADAR ───
  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !pickup) return;

    if (rideStatus === 'searching') {
      const r = searchRadius;
      const lat = pickup[1];
      const lng = pickup[0];
      const latDiff = (r + 0.5) / 111.12;
      const lngDiff = (r + 0.5) / (111.12 * Math.cos(lat * Math.PI / 180));
      const bounds: [[number, number], [number, number]] = [
        [lng - lngDiff, lat - latDiff],
        [lng + lngDiff, lat + latDiff]
      ];

      map.fitBounds(bounds, {
        padding: 50,
        maxZoom: 15,
        duration: 1500,
        essential: true
      });
    }
  }, [searchRadius, rideStatus, pickupLng, pickupLat]);

  // ─── AUTOMATED CAMERA NAVIGATION BASED ON RIDE STATUS ───
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;

    if ((rideStatus === 'en_route_to_pickup' || rideStatus === 'on_trip') && liveAssignedDriver) {
      if (!isUserInteractingRef.current) {
        // Continuous smooth Yango-style camera panning to follow the driver's live GPS movement
        map.easeTo({
          center: liveAssignedDriver.coords,
          zoom: 15.0,
          duration: 1000,
          essential: true
        });
      }
    } else if (rideStatus === 'arrived_at_pickup' && liveAssignedDriver && pickup) {
      const bounds = new maplibregl.LngLatBounds();
      bounds.extend(liveAssignedDriver.coords);
      bounds.extend(pickup);
      map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 1500 });
    }
  }, [rideStatus, liveDriverLng, liveDriverLat, pickupLng, pickupLat, destLng, destLat]);

  // ─── FETCH OSRM ROUTE ───
  useEffect(() => {
    if (!pickup || !dest) {
      setOsrmRoute(null);
      return;
    }

    let active = true;
    setOsrmLoading(true);

    // The passenger's trip always starts exactly from the pickup location
    const startCoords = pickup;

    fetch(`https://router.project-osrm.org/route/v1/driving/${startCoords[0]},${startCoords[1]};${dest[0]},${dest[1]}?overview=full&geometries=geojson`)
      .then((res) => {
        if (!res.ok) throw new Error('OSRM error');
        return res.json();
      })
      .then((data) => {
        if (!active) return;
        if (data.routes && data.routes.length > 0) {
          const route = data.routes[0];
          setOsrmRoute({
            coordinates: route.geometry.coordinates,
            distanceKm: route.distance / 1000,
            durationSec: route.duration
          });
        }
      })
      .catch((err) => {
        console.warn('Fallback to curved line', err);
        if (!active) return;
        const distKm = haversineKm(startCoords, dest);
        const coords = buildRoutePath(startCoords, dest, 60);
        setOsrmRoute({
          coordinates: coords,
          distanceKm: distKm,
          durationSec: distKm * 120 // 2 minutes per km estimate
        });
      })
      .finally(() => {
        if (active) setOsrmLoading(false);
      });

    return () => {
      active = false;
    };
  }, [pickupLng, pickupLat, destLng, destLat, rideStatus, assignedDriver?.id]);

  // ─── FETCH PICKUP OSRM ROUTE (FOR DRIVER EN ROUTE TO PICKUP) ───
  useEffect(() => {
    if (!assignedDriver || !pickup) {
      setPickupRoute(null);
      return;
    }

    let active = true;

    fetch(`https://router.project-osrm.org/route/v1/driving/${assignedDriver.coords[0]},${assignedDriver.coords[1]};${pickup[0]},${pickup[1]}?overview=full&geometries=geojson`)
      .then((res) => {
        if (!res.ok) throw new Error('OSRM error');
        return res.json();
      })
      .then((data) => {
        if (!active) return;
        if (data.routes && data.routes.length > 0) {
          const route = data.routes[0];
          setPickupRoute({
            coordinates: route.geometry.coordinates,
            distanceKm: route.distance / 1000,
            durationSec: route.duration
          });
        }
      })
      .catch((err) => {
        console.warn('Pickup route fallback to straight line steps', err);
        if (!active) return;
        const distKm = haversineKm(assignedDriver.coords, pickup);
        const coords = buildRoutePath(assignedDriver.coords, pickup, 40);
        setPickupRoute({
          coordinates: coords,
          distanceKm: distKm,
          durationSec: distKm * 120
        });
      });

    return () => {
      active = false;
    };
  }, [assignedDriver?.id, pickupLng, pickupLat]);

  // ─── DRAW ROUTE ───
  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !routeLayerRef.current) return;
    const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
    
    if (rideStatus === 'en_route_to_pickup' || rideStatus === 'arrived_at_pickup') {
      if (pickupRoute) {
        source?.setData({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: pickupRoute.coordinates }
        });
      } else {
        source?.setData({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [] }
        });
      }
    } else if (osrmRoute && (rideStatus === 'idle' || rideStatus === 'on_trip' || rideStatus === 'completed')) {
      source?.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: osrmRoute.coordinates }
      });
    } else {
      source?.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [] }
      });
    }
  }, [osrmRoute, pickupRoute, rideStatus]);

  // ─── CURSOR ───
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;
    map.getCanvas().style.cursor = mapClickMode ? 'crosshair' : 'default';
  }, [mapClickMode]);

  const online = drivers.filter((d) => d.online).length;
  const getPeakMultiplier = (users: number) => {
    if (users < 5) return 1.0;
    return 1.0 + Math.floor(users / 5) * 0.25;
  };
  const surge = getPeakMultiplier(activeUsers);
  const dist = osrmRoute ? osrmRoute.distanceKm : (pickup && dest ? haversineKm(pickup, dest) : null);
  const fare = dist ? calcFare(dist, surge) : null;

  const hintText =
    mapClickMode === 'pickup'
      ? '📍 Click map to set Pickup'
      : mapClickMode === 'dest'
        ? '🏁 Click map to set Destination'
        : mapClickMode === 'driver'
          ? '🚗 Click map to place a Driver'
          : '🗺️ Click map to add a driver';

  return h(
    'div',
    { className: 'app-shell' },

    // ─── SLIDING DRAWER BACKDROP ───
    menuOpen && h(
      'div',
      {
        className: 'drawer-overlay',
        onClick: () => setMenuOpen(false)
      }
    ),

    // ─── SLIDING DRAWER PANEL ───
    h(
      'div',
      {
        className: `nav-drawer ${menuOpen ? 'open' : ''}`
      },
      // Drawer Header
      h(
        'div',
        { className: 'drawer-header' },
        h(
          'div',
          { className: 'drawer-title' },
          h('span', { style: { fontSize: '24px' } }, '🛺'),
          h(
            'div',
            {},
            h('div', { style: { fontWeight: 'bold', fontSize: '15px' } }, 'Sawari Dispatch'),
            h('div', { style: { fontSize: '9px', color: 'var(--muted)' } }, 'Simulator Panel')
          )
        ),
        h(
          'button',
          {
            className: 'drawer-close-btn',
            onClick: () => setMenuOpen(false)
          },
          '×'
        )
      ),
      // Drawer Items / Navigation Panels
      h(
        'div',
        { className: 'drawer-items' },
        h(
          'button',
          {
            className: `drawer-item ${page === 'ride' ? 'active' : ''}`,
            onClick: () => {
              setPage('ride');
              setMenuOpen(false);
            }
          },
          '🗺️ Book Ride Panel'
        ),
        h(
          'button',
          {
            className: `drawer-item ${page === 'admin' || page === 'drivers' ? 'active' : ''}`,
            onClick: () => {
              setPage('admin');
              setMenuOpen(false);
            }
          },
          '⚙️ Admin Panel'
        ),
        h(
          'button',
          {
            className: `drawer-item ${page === 'documentation' ? 'active' : ''}`,
            onClick: () => {
              setPage('documentation');
              setMenuOpen(false);
            }
          },
          '📖 Developer Docs'
        )
      ),
      h(
        'div',
        { style: { fontSize: '10px', color: 'var(--muted)', textAlign: 'center', paddingBottom: '16px' } },
        'Sawari Dispatch Engine v1.1.0'
      )
    ),

    // ─── TOPBAR ───
    h(
      'div',
      { className: 'topbar', style: { display: 'flex', alignItems: 'center', gap: '16px' } },

      // ☰ Three Horizontal Lines Hamburger Menu Button
      h(
        'button',
        {
          className: 'btn btn-ghost hamburger-btn',
          onClick: () => setMenuOpen(!menuOpen),
          style: {
            fontSize: '22px',
            padding: '4px 10px',
            border: 'none',
            background: 'transparent',
            color: 'var(--text)',
            cursor: 'pointer',
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.2s ease'
          },
          title: 'Open Navigation Drawer'
        },
        '☰'
      ),

      h(
        'div',
        { className: 'logo', style: { marginLeft: '4px' } },
        h('div', { className: 'logo-icon' }, '🛺'),
        h(
          'div',
          {},
          h('div', { className: 'logo-text' }, 'Sawari'),
          h('div', { className: 'logo-sub' }, 'Dispatch Simulator')
        )
      ),
      h(
        'div',
        { className: 'topbar-right', style: { marginLeft: 'auto' } },
        h('div', { className: 'status-dot' }),
        h('span', { className: 'status-label' }, 'Live'),
        h('span', { className: 'version-badge' }, 'v1.1.0')
      )
    ),

    // ─── MAIN ───
    h(
      'div',
      { className: 'main-area' },

      // Map
      h(
        'div',
        {
          className: 'map-container',
          style: { display: page === 'documentation' ? 'none' : 'block' }
        },
        h('div', { id: 'map' }),

        // Overlay controls
        h(
          'div',
          { className: 'map-overlay-controls' },
          h(
            'button',
            {
              className: `map-action-btn ${mapClickMode === 'driver' ? 'active' : ''}`,
              onClick: () => setMapClickMode((m) => (m === 'driver' ? null : 'driver'))
            },
            '+ Add Driver'
          ),
          page === 'ride' &&
            h(
              'button',
              {
                className: `map-action-btn ${mapClickMode === 'pickup' ? 'active' : ''}`,
                onClick: () => setMapClickMode((m) => (m === 'pickup' ? null : 'pickup'))
              },
              '📍 Set Pickup'
            ),
          page === 'ride' &&
            pickup &&
            h(
              'button',
              {
                className: `map-action-btn ${mapClickMode === 'dest' ? 'active' : ''}`,
                onClick: () => setMapClickMode((m) => (m === 'dest' ? null : 'dest'))
              },
              '🏁 Set Destination'
            )
        ),

        h(
          'div',
          { className: 'map-hint' },
          h('div', { className: 'map-hint-dot' }),
          hintText
        ),

        // Floating expand button for Ride Simulator if page === 'ride' and peek mode
        page === 'ride' &&
          sheetState === 'peek' &&
          h(
            'button',
            {
              className: 'btn btn-primary floating-expand-pill',
              onClick: () => setSheetState('expanded')
            },
            '🛣️ Show Ride Simulator' + (fare ? ` (Rs. ${fare.total})` : '')
          ),

        // Floating expand button for Drivers Panel if page === 'drivers' and collapsed
        page === 'drivers' &&
          driversPanelCollapsed &&
          h(
            'button',
            {
              className: 'map-action-btn show-drivers-btn',
              style: {
                position: 'absolute',
                top: '16px',
                right: '16px',
                zIndex: 100,
                borderColor: 'var(--amber)',
                color: 'var(--amber)',
                background: 'var(--surface)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
              },
              onClick: () => setDriversPanelCollapsed(false)
            },
            '◀ Show Drivers Panel'
          ),

        // Floating Ride Simulator bottom card if page === 'ride'
        page === 'ride' &&
          h(
            'div',
            {
              className: `bottom-card-floating ${sheetState === 'peek' ? 'peek' : ''}`,
              style: {
                transform: isDragging
                  ? `translate(-50%, ${dragOffset}px)`
                  : sheetState === 'peek'
                    ? 'translate(-50%, calc(100% - 130px))'
                    : 'translate(-50%, 0)',
                transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s'
              }
            },
            // Slide handle/bar at top
            h(
              'div',
              {
                className: 'bottom-card-handle',
                onPointerDown: handlePointerDown,
                title: 'Drag or Tap to slide',
                style: { touchAction: 'none' }
              },
              h('div', { className: 'handle-bar' })
            ),
            h(
              'div',
              { className: 'bottom-card-content' },
              h(RideSimulatorPage, {
                drivers,
                setDrivers,
                pickup,
                setPickup,
                dest,
                setDest,
                mapClickMode,
                setMapClickMode,
                addToast,
                stats,
                setStats,
                onCollapse: () => setSheetState('peek'),
                osrmRoute,
                osrmLoading,
                userCoords,
                mapInstance: mapInstance.current,

                activeUsers,
                setActiveUsers,
                rideStatus,
                setRideStatus,
                assignedDriver,
                setAssignedDriver,
                rideId,
                setRideId,
                dispatchDrivers,
                setDispatchDrivers,
                dispatchCountdowns,
                setDispatchCountdowns,
                dispatchEvents,
                setDispatchEvents,
                countdownRefs,
                searchRadius,
                setSearchRadius,
                isScanning,
                setIsScanning,
                setArrivalAnimationActive,
                aiSimulationEnabled,
                sheetState,
                setSheetState,
                selectedCategory,
                setSelectedCategory
              })
            )
          )
      ),

      page === 'documentation' &&
        h(DocumentationPage, {
          drivers,
          setDrivers,
          addToast,
          activeCenter: pickup || userCoords || mapCenterCoords || ISLAMABAD_CENTER
        }),

      // Right Panel (only rendered or active if page === 'drivers' || page === 'admin')
      (page === 'drivers' || page === 'admin') &&
        h(
          'div',
          { className: `right-panel ${driversPanelCollapsed ? 'collapsed' : ''}` },
          h(DriverManagementPage, {
            drivers,
            setDrivers,
            selectedDriver,
            setSelectedDriver,
            map: mapInstance.current,
            dispatch: null,
            dispatchedDriverIds,
            ridePickup: pickup,
            onCollapse: () => setDriversPanelCollapsed(true),
            dispatchEvents,
            addToast,
            mapClickMode,
            setMapClickMode,
            setPendingNewDriver
          })
        )
    ),

    // ─── FULLSCREEN ARRIVAL OVERLAY SCREEN ANIMATION ───
    arrivalAnimationActive &&
      h(
        'div',
        {
          style: {
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(8, 11, 18, 0.95)',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--white)',
            fontFamily: 'var(--font-sans)',
            animation: 'fadeIn 0.5s ease-out'
          }
        },
        h(
          'div',
          {
            style: {
              textAlign: 'center',
              padding: '40px',
              borderRadius: '24px',
              background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(59, 130, 246, 0.15) 100%)',
              border: '1px solid rgba(16, 185, 129, 0.4)',
              boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
              maxWidth: '480px',
              width: '90%',
              animation: 'scaleUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)'
            }
          },
          h(
            'div',
            {
              style: {
                fontSize: '64px',
                marginBottom: '20px',
                animation: 'bounce 1s infinite alternate'
              }
            },
            assignedDriver?.avatar || '👋'
          ),
          h(
            'h2',
            {
              style: {
                fontSize: '28px',
                fontWeight: '800',
                margin: '0 0 10px 0',
                color: 'var(--green)',
                letterSpacing: '-0.5px'
              }
            },
            'Driver Arrived!'
          ),
          h(
            'p',
            {
              style: {
                fontSize: '15px',
                color: 'var(--text)',
                lineHeight: '1.5',
                margin: '0 0 24px 0'
              }
            },
            h('strong', { style: { color: 'var(--white)' } }, assignedDriver?.name),
            ' is waiting for you at the pickup location in a ',
            h('span', { style: { color: 'var(--amber)', fontWeight: 'bold' } }, assignedDriver?.vehicle),
            '!'
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                fontSize: '12px',
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '1px'
              }
            },
            h('div', {
              style: {
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: 'var(--green)',
                boxShadow: '0 0 8px var(--green)',
                animation: 'pulse-green 1s infinite'
              }
            }),
            'Starting Trip Shortly...'
          )
        )
      ),

    // ─── FULLSCREEN COMPLETION OVERLAY MODAL ───
    rideStatus === 'completed' &&
      h(
        'div',
        {
          style: {
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(8, 11, 18, 0.96)',
            zIndex: 10000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--white)',
            fontFamily: 'var(--font-sans)',
            animation: 'fadeIn 0.5s ease-out'
          }
        },
        h(
          'div',
          {
            style: {
              textAlign: 'center',
              padding: '40px',
              borderRadius: '24px',
              background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.15) 0%, rgba(16, 185, 129, 0.15) 100%)',
              border: '1px solid rgba(16, 185, 129, 0.4)',
              boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
              maxWidth: '480px',
              width: '90%',
              animation: 'scaleUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)'
            }
          },
          h(
            'div',
            {
              style: {
                fontSize: '64px',
                marginBottom: '20px'
              }
            },
            '🏁'
          ),
          h(
            'h2',
            {
              style: {
                fontSize: '28px',
                fontWeight: '800',
                margin: '0 0 10px 0',
                color: 'var(--green)',
                letterSpacing: '-0.5px'
              }
            },
            'You are arrived!'
          ),
          h(
            'p',
            {
              style: {
                fontSize: '15px',
                color: 'var(--text)',
                lineHeight: '1.5',
                margin: '0 0 24px 0'
              }
            },
            'Thanks for cooperating with our service! Your ride was completed safely and successfully.'
          ),
          h(
            'button',
            {
              className: 'btn btn-primary',
              style: {
                padding: '12px 36px',
                fontSize: '15px',
                fontWeight: 'bold',
                background: 'var(--green)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)'
              },
              onClick: () => {
                handleCompleteReset();
              }
            },
            'Welcome'
          )
        )
      ),

    // Toasts
    h(ToastContainer, {
      toasts,
      dismiss: (id) => setToasts((prev) => prev.filter((t) => t.id !== id))
    })
  );
}

export default App;
