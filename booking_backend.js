/*
 * EV CHARGING NETWORK - BOOKING SYSTEM BACKEND
 * Node.js + Express + SQLite
 * 
 * Features:
 * - Real-time charger status tracking (from MQTT)
 * - Booking management (create, read, update, cancel)
 * - Smart charging time estimation
 * - Availability calendar
 * - User management
 * - REST API for dashboard
 * 
 * Data flow:
 * OpenEVSE (Sim or Real) → MQTT → Backend (this file) → REST API → Dashboard
 * 
 * Seamless swap: Change MQTT topic in config, everything else unchanged!
 */

const express = require('express');
const mqtt = require('mqtt');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');

// ============================================================================
// CONFIGURATION
// ============================================================================

const config = {
  // MQTT Configuration (same for simulator and real hardware!)
  mqtt: {
    broker: process.env.MQTT_BROKER || 'mqtt://localhost:1883',
    baseTopic: 'ev/chargers',  // Both simulator and real OpenEVSE use this!
    subscribeTopics: [
      'ev/chargers/+/state',
      'ev/chargers/+/current',
      'ev/chargers/+/temperature',
      'ev/chargers/+/pilot',
      'ev/chargers/+/status',
      'ev/chargers/+/rssi'
    ]
  },
  
  // Server Configuration
  server: {
    port: process.env.PORT || 3001,
    host: '0.0.0.0'
  },
  
  // Database
  database: {
    path: process.env.DB_PATH || './chargers.db'
  },
  
  // Charger Configuration
  chargers: {
    // Define your charger locations and specs
    locations: {
      'locationA': {
        name: 'Charging Station A (Home)',
        maxCurrent: 32,        // Amps
        maxPower: 7.4,         // kW (single phase)
        location: 'Building A',
        coordinates: { lat: -37.8, lng: 144.9 }
      },
      'locationB': {
        name: 'Charging Station B (Office)',
        maxCurrent: 32,
        maxPower: 7.4,
        location: 'Building B',
        coordinates: { lat: -37.81, lng: 144.91 }
      },
      'locationC': {
        name: 'Charging Station C (Public)',
        maxCurrent: 63,
        maxPower: 22,          // Three phase
        location: 'Car Park',
        coordinates: { lat: -37.82, lng: 144.92 }
      }
    },
    
    // Battery specs for time estimation (user selectable)
    batteryProfiles: {
      'ev_small': { capacity: 40, name: 'Small EV (40 kWh)', defaultSOC: 20 },
      'ev_medium': { capacity: 60, name: 'Medium EV (60 kWh)', defaultSOC: 20 },
      'ev_large': { capacity: 100, name: 'Large EV (100 kWh)', defaultSOC: 20 }
    }
  }
};

// ============================================================================
// GLOBALS
// ============================================================================

let mqttClient = null;
let db = null;

// Real-time charger state (from MQTT)
let chargerState = {};

// Initialize charger state structure
Object.keys(config.chargers.locations).forEach(loc => {
  chargerState[loc] = {
    location: loc,
    state: 'unknown',
    current: 0,
    temperature: 0,
    pilot: 0,
    status: 'offline',
    rssi: 0,
    lastUpdate: null,
    estimatedEndTime: null,
    currentBookingId: null
  };
});

// ============================================================================
// EXPRESS SETUP
// ============================================================================

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// Serve static files (dashboard)
app.use(express.static(__dirname));

// Serve dashboard on root
app.get('/', (req, res) => {
  const fs = require('fs');
  const html = fs.readFileSync(__dirname + '/dashboard.html', 'utf8');
  res.type('text/html');
  res.send(html);
});
// ============================================================================
// DATABASE INITIALIZATION
// ============================================================================

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(config.database.path, (err) => {
      if (err) {
        console.error('[DB] Error opening database:', err);
        reject(err);
        return;
      }

      // Create tables
      db.serialize(() => {
        // Users table
        db.run(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            phone TEXT,
            vehicleType TEXT DEFAULT 'ev_medium',
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Bookings table
        db.run(`
          CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER NOT NULL,
            locationId TEXT NOT NULL,
            startTime DATETIME NOT NULL,
            endTime DATETIME NOT NULL,
            estimatedChargingTime INTEGER,
            targetSOC INTEGER DEFAULT 80,
            status TEXT DEFAULT 'confirmed',
            notes TEXT,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id),
            UNIQUE(locationId, startTime, endTime)
          )
        `);

        // Charging sessions table (for history)
        db.run(`
          CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bookingId INTEGER,
            locationId TEXT NOT NULL,
            startTime DATETIME NOT NULL,
            endTime DATETIME,
            energyDelivered REAL,
            averageCurrent REAL,
            peakTemperature REAL,
            cost REAL,
            FOREIGN KEY (bookingId) REFERENCES bookings(id)
          )
        `);

        console.log('[DB] Database initialized');
        resolve();
      });
    });
  });
}

// ============================================================================
// MQTT CLIENT SETUP
// ============================================================================

function initializeMQTT() {
  return new Promise((resolve, reject) => {
    console.log('[MQTT] Connecting to broker...');
    
    mqttClient = mqtt.connect(config.mqtt.broker);

    mqttClient.on('connect', () => {
      console.log('[MQTT] Connected!');
      
      // Subscribe to all charger topics
      config.mqtt.subscribeTopics.forEach(topic => {
        mqttClient.subscribe(topic, (err) => {
          if (err) console.error('[MQTT] Subscribe error:', err);
        });
      });
      
      console.log('[MQTT] Subscribed to charger topics');
      resolve();
    });

    mqttClient.on('message', (topic, message) => {
      handleMQTTMessage(topic, message.toString());
    });

    mqttClient.on('error', (err) => {
      console.error('[MQTT] Error:', err);
      reject(err);
    });

    mqttClient.on('offline', () => {
      console.log('[MQTT] Offline');
    });

    mqttClient.on('reconnect', () => {
      console.log('[MQTT] Reconnecting...');
    });
  });
}

function handleMQTTMessage(topic, message) {
  // Parse topic: ev/chargers/locationA/state
  const parts = topic.split('/');
  if (parts.length !== 4) return;

  const location = parts[2];
  const key = parts[3];

  if (!chargerState[location]) {
    chargerState[location] = {
      location,
      state: 'unknown',
      current: 0,
      temperature: 0,
      pilot: 0,
      status: 'offline',
      rssi: 0,
      lastUpdate: new Date(),
      estimatedEndTime: null,
      currentBookingId: null
    };
  }

  // Update charger state
  if (key === 'state') {
    chargerState[location].state = message;
  } else if (key === 'current') {
    chargerState[location].current = parseFloat(message) || 0;
  } else if (key === 'temperature') {
    chargerState[location].temperature = parseFloat(message) || 0;
  } else if (key === 'pilot') {
    chargerState[location].pilot = parseInt(message) || 0;
  } else if (key === 'status') {
    chargerState[location].status = message;
  } else if (key === 'rssi') {
    chargerState[location].rssi = parseInt(message) || 0;
  }

  chargerState[location].lastUpdate = new Date();

  // Update estimated end time if charging
  if (chargerState[location].state === '0x02' && chargerState[location].current > 0) {
    updateEstimatedEndTime(location);
  }
}

// ============================================================================
// CHARGING TIME ESTIMATION
// ============================================================================

function calculateChargingTime(locationId, targetSOC = 80, batteryProfile = 'ev_medium') {
  /*
   * Estimate charging time based on:
   * - Current power delivery
   * - Battery capacity
   * - Target SOC (State of Charge)
   * - Current vehicle SOC (default 20%)
   */

  const charger = config.chargers.locations[locationId];
  const battery = config.chargers.batteryProfiles[batteryProfile];

  if (!charger || !battery) return null;

  const state = chargerState[locationId];
  if (!state || state.current <= 0) return null;

  // Calculate power in kW
  const voltage = 230; // Single phase (typical)
  const power = (state.current * voltage) / 1000;

  // Energy needed (kWh)
  const startSOC = battery.defaultSOC || 20;
  const energyNeeded = (battery.capacity * (targetSOC - startSOC)) / 100;

  // Simple calculation (doesn't account for charging curve)
  const chargingTimeHours = energyNeeded / power;
  const chargingTimeMinutes = Math.round(chargingTimeHours * 60);

  return {
    energyNeeded: energyNeeded.toFixed(2),
    currentPower: power.toFixed(2),
    estimatedMinutes: chargingTimeMinutes,
    estimatedHours: chargingTimeHours.toFixed(1)
  };
}

function updateEstimatedEndTime(locationId) {
  const est = calculateChargingTime(locationId);
  if (est) {
    const endTime = new Date(Date.now() + est.estimatedMinutes * 60000);
    chargerState[locationId].estimatedEndTime = endTime;
  }
}

// ============================================================================
// REST API ENDPOINTS
// ============================================================================

// GET /api/chargers - All chargers with real-time status
app.get('/api/chargers', (req, res) => {
  const chargers = Object.entries(config.chargers.locations).map(([id, config]) => ({
    id,
    ...config,
    state: chargerState[id] || {}
  }));

  res.json({
    success: true,
    data: chargers,
    timestamp: new Date()
  });
});

// GET /api/chargers/:locationId - Single charger details
app.get('/api/chargers/:locationId', (req, res) => {
  const { locationId } = req.params;
  const charger = config.chargers.locations[locationId];

  if (!charger) {
    return res.status(404).json({
      success: false,
      error: 'Charger not found'
    });
  }

  res.json({
    success: true,
    data: {
      id: locationId,
      ...charger,
      state: chargerState[locationId] || {}
    }
  });
});

// GET /api/availability/:locationId/:date - Check availability for date
app.get('/api/availability/:locationId/:date', (req, res) => {
  const { locationId, date } = req.params;

  db.all(
    `SELECT startTime, endTime FROM bookings 
     WHERE locationId = ? AND DATE(startTime) = ? AND status != 'cancelled'`,
    [locationId, date],
    (err, rows) => {
      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      // Generate 1-hour slots for the day
      const slots = generateDaySlots(date, rows || []);

      res.json({
        success: true,
        date,
        locationId,
        availableSlots: slots.filter(s => s.available),
        bookedSlots: slots.filter(s => !s.available),
        totalSlots: slots.length
      });
    }
  );
});

function generateDaySlots(date, bookings) {
  const slots = [];
  const dayStart = new Date(`${date}T00:00:00`);

  for (let hour = 0; hour < 24; hour++) {
    const slotStart = new Date(dayStart);
    slotStart.setHours(hour);
    const slotEnd = new Date(slotStart);
    slotEnd.setHours(hour + 1);

    const isBooked = bookings.some(b => {
      const bStart = new Date(b.startTime);
      const bEnd = new Date(b.endTime);
      return slotStart < bEnd && slotEnd > bStart;
    });

    slots.push({
      start: slotStart.toISOString(),
      end: slotEnd.toISOString(),
      available: !isBooked && slotStart > new Date() // Can't book past times
    });
  }

  return slots;
}

// POST /api/estimate - Estimate charging time
app.post('/api/estimate', (req, res) => {
  const { locationId, targetSOC = 80, batteryProfile = 'ev_medium' } = req.body;

  const est = calculateChargingTime(locationId, targetSOC, batteryProfile);

  if (!est) {
    return res.status(400).json({
      success: false,
      error: 'Cannot estimate charging time (charger not available or not charging)'
    });
  }

  res.json({
    success: true,
    data: est
  });
});

// POST /api/bookings - Create new booking
app.post('/api/bookings', (req, res) => {
  const { userId, locationId, startTime, endTime, targetSOC = 80, notes = '' } = req.body;

  // Validation
  if (!userId || !locationId || !startTime || !endTime) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields'
    });
  }

  const start = new Date(startTime);
  const end = new Date(endTime);

  if (start >= end) {
    return res.status(400).json({
      success: false,
      error: 'Start time must be before end time'
    });
  }

  // Check if user exists, create if not
  db.run(
    `INSERT OR IGNORE INTO users (id, name, email) VALUES (?, ?, ?)`,
    [userId, `User ${userId}`, `user${userId}@example.com`],
    function(err) {
      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      // Create booking
      const estimatedChargingTime = calculateChargingTime(
        locationId,
        targetSOC,
        'ev_medium'
      )?.estimatedMinutes || 0;

      db.run(
        `INSERT INTO bookings (userId, locationId, startTime, endTime, estimatedChargingTime, targetSOC, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, locationId, start.toISOString(), end.toISOString(), estimatedChargingTime, targetSOC, notes],
        function(err) {
          if (err) {
            if (err.message.includes('UNIQUE constraint')) {
              return res.status(409).json({
                success: false,
                error: 'Time slot not available (booking conflict)'
              });
            }
            return res.status(500).json({
              success: false,
              error: err.message
            });
          }

          res.status(201).json({
            success: true,
            data: {
              id: this.lastID,
              userId,
              locationId,
              startTime,
              endTime,
              estimatedChargingTime,
              targetSOC,
              status: 'confirmed',
              createdAt: new Date()
            }
          });
        }
      );
    }
  );
});

// GET /api/bookings - List all bookings
app.get('/api/bookings', (req, res) => {
  const { userId, locationId, status = 'confirmed' } = req.query;

  let query = 'SELECT * FROM bookings WHERE 1=1';
  const params = [];

  if (userId) {
    query += ' AND userId = ?';
    params.push(userId);
  }
  if (locationId) {
    query += ' AND locationId = ?';
    params.push(locationId);
  }
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY startTime DESC LIMIT 100';

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({
        success: false,
        error: err.message
      });
    }

    res.json({
      success: true,
      data: rows || []
    });
  });
});

// GET /api/bookings/:bookingId - Get single booking
app.get('/api/bookings/:bookingId', (req, res) => {
  const { bookingId } = req.params;

  db.get(
    'SELECT * FROM bookings WHERE id = ?',
    [bookingId],
    (err, row) => {
      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      if (!row) {
        return res.status(404).json({
          success: false,
          error: 'Booking not found'
        });
      }

      res.json({
        success: true,
        data: row
      });
    }
  );
});

// PATCH /api/bookings/:bookingId - Cancel booking
app.patch('/api/bookings/:bookingId', (req, res) => {
  const { bookingId } = req.params;
  const { status } = req.body;

  if (!['confirmed', 'cancelled'].includes(status)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid status'
    });
  }

  db.run(
    'UPDATE bookings SET status = ? WHERE id = ?',
    [status, bookingId],
    function(err) {
      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      if (this.changes === 0) {
        return res.status(404).json({
          success: false,
          error: 'Booking not found'
        });
      }

      res.json({
        success: true,
        message: `Booking ${status}`
      });
    }
  );
});

// GET /api/sessions/:bookingId - Charging session history
app.get('/api/sessions/:bookingId', (req, res) => {
  const { bookingId } = req.params;

  db.get(
    'SELECT * FROM sessions WHERE bookingId = ?',
    [bookingId],
    (err, row) => {
      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      res.json({
        success: true,
        data: row || null
      });
    }
  );
});

// ============================================================================
// STARTUP
// ============================================================================

async function startup() {
  try {
    console.log('================================================');
    console.log('EV CHARGING NETWORK - BOOKING SYSTEM');
    console.log('================================================');

    await initializeDatabase();
    await initializeMQTT();

    app.listen(config.server.port, config.server.host, () => {
      console.log(`[Server] Listening on ${config.server.host}:${config.server.port}`);
      console.log('');
      console.log('API Endpoints:');
      console.log('  GET  /api/chargers');
      console.log('  GET  /api/chargers/:locationId');
      console.log('  GET  /api/availability/:locationId/:date');
      console.log('  POST /api/estimate');
      console.log('  POST /api/bookings');
      console.log('  GET  /api/bookings');
      console.log('  GET  /api/bookings/:bookingId');
      console.log('  PATCH /api/bookings/:bookingId');
      console.log('  GET  /api/sessions/:bookingId');
      console.log('');
      console.log('Dashboard: http://localhost:' + config.server.port);
      console.log('');
    });
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
}

startup();

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (mqttClient) mqttClient.end();
  if (db) db.close();
  process.exit(0);
});

module.exports = app;
