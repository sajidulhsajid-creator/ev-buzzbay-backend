const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('\n================================================');
console.log('EV CHARGING NETWORK - BOOKING SYSTEM');
console.log('================================================');

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Database Setup
const db = new sqlite3.Database(':memory:');

db.serialize(() => {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      phone TEXT,
      vehicleType TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Chargers table
  db.run(`
    CREATE TABLE IF NOT EXISTS chargers (
      id TEXT PRIMARY KEY,
      name TEXT,
      location TEXT,
      maxPower REAL,
      state TEXT DEFAULT 'idle',
      current REAL DEFAULT 0,
      temperature REAL DEFAULT 0,
      pilot REAL DEFAULT 0,
      rssi INTEGER DEFAULT 0,
      status TEXT DEFAULT 'offline',
      lastUpdate DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Bookings table
  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER,
      locationId TEXT,
      startTime DATETIME,
      endTime DATETIME,
      estimatedChargingTime INTEGER,
      targetSOC INTEGER,
      status TEXT DEFAULT 'pending',
      notes TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(userId) REFERENCES users(id),
      FOREIGN KEY(locationId) REFERENCES chargers(id)
    )
  `);

  // Sessions table
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bookingId INTEGER,
      locationId TEXT,
      startTime DATETIME,
      endTime DATETIME,
      energyDelivered REAL DEFAULT 0,
      averageCurrent REAL DEFAULT 0,
      peakTemperature REAL DEFAULT 0,
      cost REAL DEFAULT 0,
      FOREIGN KEY(bookingId) REFERENCES bookings(id),
      FOREIGN KEY(locationId) REFERENCES chargers(id)
    )
  `);

  // Insert sample chargers
  const sampleChargers = [
    {
      id: 'locationA',
      name: 'Charging Station A',
      location: 'West Footscray Center',
      maxPower: 7.4,
      state: '0x02',
      status: 'online'
    },
    {
      id: 'locationB',
      name: 'Charging Station B',
      location: 'Railway Station Area',
      maxPower: 11,
      state: '0x02',
      status: 'online'
    },
    {
      id: 'locationC',
      name: 'Charging Station C',
      location: 'Car Park',
      maxPower: 7.4,
      state: '0x02',
      status: 'online'
    }
  ];

  sampleChargers.forEach(charger => {
    db.run(
      `INSERT OR REPLACE INTO chargers (id, name, location, maxPower, state, status) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [charger.id, charger.name, charger.location, charger.maxPower, charger.state, charger.status]
    );
  });

  console.log('[DB] Database initialized');
});

// MQTT Connection (Optional - not required for REST API)
let mqttConnected = false;

try {
  const mqtt = require('mqtt');
  const mqttClient = mqtt.connect('mqtt://localhost:1883', {
    connectTimeout: 1000,
    reconnectPeriod: 5000,
    clientId: 'ev-booking-backend'
  });

  mqttClient.on('connect', () => {
    console.log('[MQTT] Connected to broker');
    mqttConnected = true;
    mqttClient.subscribe('ev/chargers/#');
  });

  mqttClient.on('message', (topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      const locationId = topic.split('/')[2];
      
      if (locationId && data) {
        db.run(
          `UPDATE chargers SET state = ?, current = ?, temperature = ?, rssi = ?, status = 'online', lastUpdate = CURRENT_TIMESTAMP 
           WHERE id = ?`,
          [data.state || '0x02', data.current || 0, data.temperature || 0, data.rssi || 0, locationId],
          (err) => {
            if (err) console.error('[DB] Update error:', err);
          }
        );
      }
    } catch (err) {
      console.error('[MQTT] Message parse error:', err);
    }
  });

  mqttClient.on('error', (err) => {
    console.warn('[MQTT] Connection error (optional):', err.message);
    mqttConnected = false;
  });

  console.log('[MQTT] Attempting to connect to broker...');
} catch (err) {
  console.warn('[MQTT] MQTT not available - REST API only mode');
  mqttConnected = false;
}

// REST API Routes

// Get all chargers
app.get('/api/chargers', (req, res) => {
  db.all(`
    SELECT id, name, location, maxPower, state, current, temperature, pilot, rssi, status, lastUpdate
    FROM chargers
    ORDER BY name
  `, (err, rows) => {
    if (err) {
      return res.json({ success: false, error: err.message });
    }
    
    const chargers = rows.map(row => ({
      id: row.id,
      name: row.name,
      location: row.location,
      maxPower: row.maxPower,
      state: {
        state: row.state,
        current: row.current,
        temperature: row.temperature,
        pilot: row.pilot,
        rssi: row.rssi,
        status: row.status
      }
    }));
    
    res.json({ success: true, data: chargers });
  });
});

// Get specific charger
app.get('/api/chargers/:locationId', (req, res) => {
  const { locationId } = req.params;
  
  db.get(
    `SELECT * FROM chargers WHERE id = ?`,
    [locationId],
    (err, row) => {
      if (err) return res.json({ success: false, error: err.message });
      if (!row) return res.json({ success: false, error: 'Charger not found' });
      
      res.json({
        success: true,
        data: {
          id: row.id,
          name: row.name,
          location: row.location,
          maxPower: row.maxPower,
          state: {
            state: row.state,
            current: row.current,
            temperature: row.temperature,
            pilot: row.pilot,
            rssi: row.rssi,
            status: row.status
          }
        }
      });
    }
  );
});

// Update charger (for LoRa data)
app.post('/api/update-charger', (req, res) => {
  const { locationId, state, current, temperature, rssi } = req.body;
  
  if (!locationId) {
    return res.json({ success: false, error: 'locationId required' });
  }
  
  db.run(
    `UPDATE chargers SET state = ?, current = ?, temperature = ?, rssi = ?, status = 'online', lastUpdate = CURRENT_TIMESTAMP 
     WHERE id = ?`,
    [state || '0x02', current || 0, temperature || 0, rssi || 0, locationId],
    (err) => {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, message: 'Charger updated' });
    }
  );
});

// Get availability
app.get('/api/availability/:locationId/:date', (req, res) => {
  const { locationId, date } = req.params;
  
  db.all(
    `SELECT startTime, endTime FROM bookings 
     WHERE locationId = ? AND DATE(startTime) = ? AND status != 'cancelled'`,
    [locationId, date],
    (err, rows) => {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, bookings: rows || [] });
    }
  );
});

// Estimate charging time
app.post('/api/estimate', (req, res) => {
  const { chargerPower, batteryCapacity, targetSOC, currentSOC } = req.body;
  
  if (!chargerPower || !batteryCapacity) {
    return res.json({ success: false, error: 'Missing parameters' });
  }
  
  const soc = currentSOC || 20;
  const target = targetSOC || 80;
  const energyNeeded = (batteryCapacity * (target - soc)) / 100;
  const chargingTime = Math.round((energyNeeded / chargerPower) * 60);
  
  res.json({ success: true, chargingTime, energyNeeded });
});

// Create booking
app.post('/api/bookings', (req, res) => {
  const { userId, locationId, startTime, endTime, estimatedChargingTime, targetSOC, notes } = req.body;
  
  if (!locationId || !startTime || !endTime) {
    return res.json({ success: false, error: 'Missing required fields' });
  }
  
  db.run(
    `INSERT INTO bookings (userId, locationId, startTime, endTime, estimatedChargingTime, targetSOC, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
    [userId || 0, locationId, startTime, endTime, estimatedChargingTime || 60, targetSOC || 80, notes || ''],
    function(err) {
      if (err) return res.json({ success: false, error: err.message });
      
      res.json({
        success: true,
        message: 'Booking created',
        bookingId: this.lastID
      });
    }
  );
});

// Get bookings
app.get('/api/bookings', (req, res) => {
  db.all(
    `SELECT * FROM bookings ORDER BY createdAt DESC`,
    (err, rows) => {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, data: rows || [] });
    }
  );
});

// Get specific booking
app.get('/api/bookings/:bookingId', (req, res) => {
  const { bookingId } = req.params;
  
  db.get(
    `SELECT * FROM bookings WHERE id = ?`,
    [bookingId],
    (err, row) => {
      if (err) return res.json({ success: false, error: err.message });
      if (!row) return res.json({ success: false, error: 'Booking not found' });
      
      res.json({ success: true, data: row });
    }
  );
});

// Update booking
app.patch('/api/bookings/:bookingId', (req, res) => {
  const { bookingId } = req.params;
  const { status, notes } = req.body;
  
  db.run(
    `UPDATE bookings SET status = ?, notes = ? WHERE id = ?`,
    [status || 'confirmed', notes || '', bookingId],
    (err) => {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, message: 'Booking updated' });
    }
  );
});

// Get session
app.get('/api/sessions/:bookingId', (req, res) => {
  const { bookingId } = req.params;
  
  db.get(
    `SELECT * FROM sessions WHERE bookingId = ?`,
    [bookingId],
    (err, row) => {
      if (err) return res.json({ success: false, error: err.message });
      if (!row) return res.json({ success: false, error: 'Session not found' });
      
      res.json({ success: true, data: row });
    }
  );
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mqtt: mqttConnected ? 'connected' : 'optional (not connected)',
    database: 'ready',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'EV Charging Booking System',
    version: '1.0.0',
    status: 'running',
    mqtt: mqttConnected ? 'connected' : 'optional',
    endpoints: {
      chargers: '/api/chargers',
      bookings: '/api/bookings',
      health: '/health'
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] http://localhost:${PORT}`);
  console.log('\n✅ Booking API ready!');
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
