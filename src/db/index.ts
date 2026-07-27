import sqlite3Module from 'sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import GitHubSync from '../utils/githubSync.js';

const sqlite3 = sqlite3Module.verbose();

// Construct the database path
let dataDir;

// Use /home/user/data directory on Hugging Face Space
if (process.env.HUGGING_FACE === '1') {
  dataDir = '/home/user/data';
  console.log(`Using Hugging Face persistent data directory: ${dataDir}`);
} else {
  dataDir = path.resolve(process.cwd(), 'data');
}

if (!fs.existsSync(dataDir)) {
  console.log(`Creating data directory: ${dataDir}`);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    console.error(`Error creating data directory: ${err.message}`);
    console.error('Will attempt to use ./data as fallback');
    dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }
}

const dbPath = path.resolve(dataDir, 'database.db');
console.log(`Database path: ${dbPath}`); // Log the path for debugging

// Initialize GitHub sync if configured
const githubProject = process.env.GITHUB_PROJECT;
const githubToken = process.env.GITHUB_PROJECT_PAT;
const githubEncryptKey = process.env.GITHUB_ENCRYPT_KEY;
const githubSyncMode = process.env.GITHUB_SYNC_MODE;
const githubSyncBranch = process.env.GITHUB_SYNC_BRANCH;
const githubSyncDelaySeconds = Number.parseInt(process.env.GITHUB_SYNC_DELAY_SECONDS || '', 10);
let githubSync = null;

if (githubProject && githubToken) {
  console.log(`GitHub sync configured for repository: ${githubProject}`);
  githubSync = new GitHubSync(githubProject, githubToken, dbPath, githubEncryptKey, {
    syncMode: githubSyncMode,
    branch: githubSyncBranch,
    syncDelayMs: Number.isFinite(githubSyncDelaySeconds) && githubSyncDelaySeconds > 0
      ? githubSyncDelaySeconds * 1000
      : undefined,
  });
  
  if (githubEncryptKey && githubEncryptKey.length >= 32) {
    console.log('GitHub data encryption enabled, using AES-256-CBC algorithm');
  } else if (githubEncryptKey) {
    console.warn('GitHub encryption key length is insufficient, requires at least 32 characters, data will be stored unencrypted');
  } else {
    console.log('GitHub data encryption not enabled, data will be stored unencrypted');
  }
}

// Function to validate if a file is a valid SQLite database
function validateDatabaseFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, reason: 'File does not exist' };
    }

    const buffer = fs.readFileSync(filePath, { encoding: null });
    if (buffer.length < 16) {
      return { valid: false, reason: 'File too small to be a valid SQLite database' };
    }

    // Check SQLite file header
    const sqliteHeader = Buffer.from("SQLite format 3\0");
    const fileHeader = buffer.subarray(0, 16);

    if (Buffer.compare(fileHeader, sqliteHeader) === 0) {
      return { valid: true, reason: 'Valid SQLite database' };
    } else {
      return { valid: false, reason: 'Invalid SQLite header' };
    }
  } catch (error) {
    return { valid: false, reason: `Error reading file: ${error.message}` };
  }
}

// Initialize database with proper GitHub sync handling
async function initializeDatabase() {
  // Try to download database from GitHub BEFORE opening the database connection
  if (githubSync) {
    try {
      console.log('Attempting to download database from GitHub before opening connection...');
      const downloadSuccess = await githubSync.downloadDatabase();

      // Validate the downloaded database file
      if (downloadSuccess && fs.existsSync(dbPath)) {
        const validation = validateDatabaseFile(dbPath);
        if (!validation.valid) {
          console.warn(`Downloaded database file is invalid: ${validation.reason}`);
          console.log('Removing invalid database file and creating a new one...');
          try {
            fs.unlinkSync(dbPath);
          } catch (unlinkErr) {
            console.error('Failed to remove invalid database file:', unlinkErr.message);
          }
        } else {
          console.log('Downloaded database file validation passed');
        }
      }
    } catch (err) {
      console.error('Failed to download database from GitHub:', err.message);
      console.log('Continuing with local database...');
    }
  }

  return new Promise((resolve, reject) => {
    // Initialize the database connection after GitHub sync is complete
    // The OPEN_READWRITE | OPEN_CREATE flag ensures the file is created if it doesn't exist.
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, async (err) => {
      if (err) {
        console.error('Error opening database:', err.message);
        reject(err); // Reject to stop the application if DB connection fails
      } else {
        console.log('Connected to the SQLite database.');

        // Initialize database schema
        try {
          await new Promise<void>((schemaResolve, schemaReject) => {
            // Pass the current database instance to the schema initialization function
            initializeDatabaseSchemaInternal.call({ db: db }, (schemaErr) => {
              if (schemaErr) schemaReject(schemaErr);
              else schemaResolve();
            });
          });

          resolve(db);
        } catch (schemaErr) {
          console.error('Failed to initialize database schema:', schemaErr.message);
          reject(schemaErr);
        }
      }
    });
  });
}

// Start the database initialization
let db;
initializeDatabase()
  .then(async (database) => {
    db = database;
    console.log('Database initialization completed successfully.');

    // Initialize Vertex service after database is ready and exported
    try {
      const vertexService = await import('../services/vertexProxyService.js');
      console.log('Initializing Vertex AI service after database setup...');
      await vertexService.initializeVertexCredentials();
    } catch (err) {
      console.error('Failed to initialize Vertex service:', err.message);
    }

    // Initialize scheduler service after database is ready
    try {
      const { default: schedulerService } = await import('../services/schedulerService.js');
      console.log('Initializing Scheduler Service after database setup...');
      await schedulerService.initialize();
      console.log('Scheduler Service: Initialized successfully');
    } catch (err) {
      console.error('Scheduler Service: Failed to initialize:', err.message);
    }
  })
  .catch((err) => {
    console.error('Fatal error during database initialization:', err.message);
    process.exit(1);
  });

// Function to trigger GitHub sync (now always delayed)
async function syncToGitHub() {
  if (!githubSync) {
    return false;
  }

  try {
    // Schedule the delayed sync
    await githubSync.scheduleSync();
    return true; // Indicate scheduling was successful
  } catch (err) {
    console.error('Failed to schedule GitHub sync:', err.message);
    return false;
  }
}

// SQL statements to create tables (if they don't exist)
const createTablesSQL = `
  CREATE TABLE IF NOT EXISTS gemini_keys (
    id TEXT PRIMARY KEY,
    api_key TEXT NOT NULL UNIQUE,
    name TEXT,
    usage_date TEXT,
    model_usage TEXT DEFAULT '{}',       -- Store as JSON string
    category_usage TEXT DEFAULT '{}',    -- Store as JSON string
    error_status INTEGER,               -- 401, 403, or NULL
    consecutive_429_counts TEXT DEFAULT '{}', -- Store as JSON string
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS worker_keys (
    api_key TEXT PRIMARY KEY,
    description TEXT,
    safety_enabled INTEGER DEFAULT 1,  -- 1 for true, 0 for false
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS models_config (
    model_id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('Pro', 'Flash', 'Custom')),
    daily_quota INTEGER,                -- NULL means unlimited
    individual_quota INTEGER            -- NULL means no individual limit
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT                           -- Can store JSON strings or simple values
  );

  -- Initialize default category quotas if not present
  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('category_quotas', '{"proQuota": 50, "flashQuota": 1500}');

  -- Initialize gemini_key_list if not present (as an empty JSON array)
  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('gemini_key_list', '[]');

  -- Initialize gemini_key_index if not present
  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('gemini_key_index', '0');

  -- Add other default settings as needed, e.g., last used key ID
  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('last_used_gemini_key_id', '');
`;

// Function to initialize the database schema
function initializeDatabaseSchemaInternal(callback) {
  // Use the database instance passed via 'this' context or fall back to global db
  const currentDb = this?.db || db;
  if (!currentDb) {
    const error = new Error('Database instance not available for schema initialization');
    console.error(error.message);
    if (callback) callback(error);
    return;
  }

  currentDb.exec(createTablesSQL, (err) => {
    if (err) {
      console.error('Error creating database tables:', err.message);
      if (callback) callback(err);
    } else {
      console.log('Database tables checked/created successfully.');
      // You might seed initial data here if necessary
      if (callback) callback(null);
    }
  });
}

// Function to safely close the database connection
function closeDatabase() {
  if (db) {
    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err.message);
      } else {
        console.log('Database connection closed.');
      }
    });
  }
}

// Gracefully close the database on application exit
process.on('SIGINT', () => {
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
    closeDatabase();
    process.exit(0);
});

// Export the database connection instance and sync functions
export { db, syncToGitHub };

