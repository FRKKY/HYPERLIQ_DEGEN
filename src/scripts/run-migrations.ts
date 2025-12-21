import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  });

  try {
    // Create migrations tracking table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Get already executed migrations
    const result = await pool.query('SELECT filename FROM schema_migrations');
    const executed = new Set(result.rows.map(r => r.filename));

    // Get migration files (from /app/migrations in Docker, or ../../migrations from dist/scripts)
    const migrationsDir = join(__dirname, '..', '..', 'migrations');
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    console.log(`Found ${files.length} migration files`);

    for (const file of files) {
      if (executed.has(file)) {
        console.log(`Skipping ${file} (already executed)`);
        continue;
      }

      console.log(`Running migration: ${file}`);
      const sql = readFileSync(join(migrationsDir, file), 'utf-8');

      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await pool.query('COMMIT');
        console.log(`Completed: ${file}`);
      } catch (error) {
        await pool.query('ROLLBACK');
        console.error(`Failed: ${file}`, error);
        throw error;
      }
    }

    console.log('All migrations completed successfully');
  } finally {
    await pool.end();
  }
}

runMigrations()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
