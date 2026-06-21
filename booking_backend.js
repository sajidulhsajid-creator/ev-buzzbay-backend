const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('\n================================================');
console.log('EV CHARGING NETWORK - BOOKING SYSTEM');
console.log('================================================');

// CORS Configuration - Allow GitHub Pages
const corsOptions = {
  origin: [
    'https://sajidulhsajid-creator.github.io',
    'http://localhost:8000',
    'http://localhost:3000',
    '*'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Health check endpoint (no DB needed)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Database Setup
let db = null;

try {
  db = new sqlite3.Database(':memory:');
  
  db.serialize(() => {
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
    `, (err) => {
      if (err) console.error('[DB] Chargers table error:', err);
    });

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
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) console.error('[DB] Bookings table error:', err);
    });

    // Insert sample chargers
    const sampleChargers = [
      { id: 'locationA', name: 'Charging Station A', location: 'West Footscray Center', maxPower: 7.4, state: '0x02', status: 'online' },
      { id: 'locationB', name: 'Charging Station B', location: 'Railway Station Area', maxPower: 11, state: '0x02', status: 'online' },
      { id: 'locationC', name: 'Charging Station C', location: 'Car Park', maxPower: 7.4, state: '0x02', status: 'online' }
    ];

    sampleChargers.forEach(charger => {
      db.run(
        `INSERT OR IGNORE INTO chargers (id, name, location, maxPower, state, status) VALUES (?, ?, ?, ?, ?, ?)`,
        [charger.id, charger.name, charger.location, charger.maxPower, charger.state, charger.status],
        (err) => {
          if (err) console.error('[DB] Insert charger error:', err);
        }
      );
    });

    console.log('[DB] Database initialized');
  });
} catch (err) {
  console.error('[DB] Initialization error:', err);
}

// Home endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'EV Charging Booking System',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      chargers: '/api/chargers',
      bookings: '/api/bookings',
      health: '/health'
    }
  });
});

// Get all chargers
app.get('/api/chargers', (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Database not available' });
  }

  db.all(`
    SELECT id, name, location, maxPower, state, current, temperature, pilot, rssi, status
    FROM chargers
    ORDER BY name
  `, (err, rows) => {
    if (err) {
      console.error('[DB] Query error:', err);
      return res.status(500).json({ success: false, error: err.message });
    }
    
    const chargers = (rows || []).map(row => ({
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
  if (!db) {
    return res.status(500).json({ success: false, error: 'Database not available' });
  }

  const { locationId } = req.params;
  
  db.get(
    `SELECT * FROM chargers WHERE id = ?`,
    [locationId],
    (err, row) => {
      if (err) {
        console.error('[DB] Query error:', err);
        return res.status(500).json({ success: false, error: err.message });
      }
      if (!row) {
        return res.json({ success: false, error: 'Charger not found' });
      }
      
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

// Update charger
app.post('/api/update-charger', (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Database not available' });
  }

  const { locationId, state, current, temperature, rssi } = req.body;
  
  if (!locationId) {
    return res.json({ success: false, error: 'locationId required' });
  }
  
  db.run(
    `UPDATE chargers SET state = ?, current = ?, temperature = ?, rssi = ?, status = 'online', lastUpdate = CURRENT_TIMESTAMP WHERE id = ?`,
    [state || '0x02', current || 0, temperature || 0, rssi || 0, locationId],
    (err) => {
      if (err) {
        console.error('[DB] Update error:', err);
        return res.status(500).json({ success: false, error: err.message });
      }
      res.json({ success: true, message: 'Charger updated' });
    }
  );
});

// Get availability
app.get('/api/availability/:locationId/:date', (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Database not available' });
  }

  const { locationId, date } = req.params;
  
  db.all(
    `SELECT startTime, endTime FROM bookings WHERE locationId = ? AND DATE(startTime) = ? AND status != 'cancelled'`,
    [locationId, date],
    (err, rows) => {
      if (err) {
        console.error('[DB] Query error:', err);
        return res.status(500).json({ success: false, error: err.message });
      }
      res.json({ success: true, bookings: rows || [] });
    }
  );
});

// Estimate charging
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
  if (!db) {
    return res.status(500).json({ success: false, error: 'Database not available' });
  }

  const { userId, locationId, startTime, endTime, estimatedChargingTime, targetSOC, notes } = req.body;
  
  if (!locationId || !startTime || !endTime) {
    return res.json({ success: false, error: 'Missing required fields' });
  }
  
  db.run(
    `INSERT INTO bookings (userId, locationId, startTime, endTime, estimatedChargingTime, targetSOC, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
    [userId || 0, locationId, startTime, endTime, estimatedChargingTime || 60, targetSOC || 80, notes || ''],
    function(err) {
      if (err) {
        console.error('[DB] Insert error:', err);
        return res.status(500).json({ success: false, error: err.message });
      }
      
      res.json({
        success: true,
        message: 'Booking created',
        bookingId: this.lastID
      });
    }
  );
});

// Get all bookings
app.get('/api/bookings', (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Database not available' });
  }

  db.all(
    `SELECT * FROM bookings ORDER BY createdAt DESC`,
    (err, rows) => {
      if (err) {
        console.error('[DB] Query error:', err);
        return res.status(500).json({ success: false, error: err.message });
      }
      res.json({ success: true, data: rows || [] });
    }
  );
});

// Get specific booking
app.get('/api/bookings/:bookingId', (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Database not available' });
  }

  const { bookingId } = req.params;
  
  db.get(
    `SELECT * FROM bookings WHERE id = ?`,
    [bookingId],
    (err, row) => {
      if (err) {
        console.error('[DB] Query error:', err);
        return res.status(500).json({ success: false, error: err.message });
      }
      if (!row) {
        return res.json({ success: false, error: 'Booking not found' });
      }
      
      res.json({ success: true, data: row });
    }
  );
});

// Update booking
app.patch('/api/bookings/:bookingId', (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Database not available' });
  }

  const { bookingId } = req.params;
  const { status, notes } = req.body;
  
  db.run(
    `UPDATE bookings SET status = ?, notes = ? WHERE id = ?`,
    [status || 'confirmed', notes || '', bookingId],
    (err) => {
      if (err) {
        console.error('[DB] Update error:', err);
        return res.status(500).json({ success: false, error: err.message });
      }
      res.json({ success: true, message: 'Booking updated' });
    }
  );
});

// Error handling
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({ success: false, error: err.message });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] CORS enabled for GitHub Pages`);
  console.log('\n✅ Booking API ready!');
});

server.on('error', (err) => {
  console.error('[Server] Error:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  if (db) db.close();
  server.close();
  process.exit(0);
});
