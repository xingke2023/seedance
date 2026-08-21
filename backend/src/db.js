const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/seedance',
})

async function query(text, params) {
  return pool.query(text, params)
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      sso_user_id INT UNIQUE NOT NULL,
      username VARCHAR(50),
      name VARCHAR(100),
      email VARCHAR(200),
      avatar TEXT,
      quota INT DEFAULT 10,
      used INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INT REFERENCES users(id) NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      cover_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id)`).catch(() => {})

  await query(`
    CREATE TABLE IF NOT EXISTS videos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
      user_id INT REFERENCES users(id) NOT NULL,
      name VARCHAR(255) NOT NULL,
      script TEXT,
      subtitle_input TEXT,
      style VARCHAR(500),
      ratio VARCHAR(10) DEFAULT '9:16',
      seed INTEGER,
      params JSONB DEFAULT '{}',
      voice VARCHAR(100),
      audio_url TEXT,
      merged_video_url TEXT,
      sort_order INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_videos_project ON videos(project_id)`).catch(() => {})
  await query(`CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id)`).catch(() => {})

  await query(`
    CREATE TABLE IF NOT EXISTS shots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      video_id UUID REFERENCES videos(id) ON DELETE CASCADE NOT NULL,
      shot_number INT NOT NULL,
      title VARCHAR(255),
      description TEXT,
      prompt TEXT,
      subtitle TEXT,
      duration NUMERIC(5,2) DEFAULT 8,
      ratio VARCHAR(10),
      mood VARCHAR(100),
      camera_movement VARCHAR(100),
      camera_position_x NUMERIC(10,4) DEFAULT 0,
      camera_position_y NUMERIC(10,4) DEFAULT 5,
      camera_position_z NUMERIC(10,4) DEFAULT 10,
      camera_target_x NUMERIC(10,4) DEFAULT 0,
      camera_target_y NUMERIC(10,4) DEFAULT 0,
      camera_target_z NUMERIC(10,4) DEFAULT 0,
      camera_fov NUMERIC(5,2) DEFAULT 60,
      camera_movement_type VARCHAR(20) DEFAULT 'static',
      camera_movement_path JSONB,
      reference_images JSONB DEFAULT '[]',
      subjects JSONB DEFAULT '[]',
      task_id VARCHAR(100),
      task_status VARCHAR(20) DEFAULT 'idle',
      video_url TEXT,
      local_url TEXT,
      video_duration NUMERIC(5,2),
      task_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_shots_video ON shots(video_id)`).catch(() => {})
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_shots_video_order ON shots(video_id, shot_number)`).catch(() => {})
  await query(`ALTER TABLE shots ADD COLUMN IF NOT EXISTS shot_type VARCHAR(30)`).catch(() => {})
  await query(`ALTER TABLE shots ADD COLUMN IF NOT EXISTS lighting VARCHAR(30)`).catch(() => {})
  await query(`ALTER TABLE shots ADD COLUMN IF NOT EXISTS roll_type VARCHAR(10)`).catch(() => {})
  await query(`ALTER TABLE shots ADD COLUMN IF NOT EXISTS voice_style VARCHAR(20)`).catch(() => {})

  await query(`
    CREATE TABLE IF NOT EXISTS video_media (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      video_id UUID REFERENCES videos(id) ON DELETE CASCADE NOT NULL,
      media_type VARCHAR(10) NOT NULL,
      url TEXT NOT NULL,
      name VARCHAR(255),
      preview_url TEXT,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_video_media_video ON video_media(video_id)`).catch(() => {})

  await query(`
    CREATE TABLE IF NOT EXISTS project_subjects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
      label VARCHAR(100) NOT NULL,
      description TEXT,
      image_url TEXT,
      asset_id VARCHAR(100),
      sort_order INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_project_subjects_project ON project_subjects(project_id)`).catch(() => {})

  await query(`
    CREATE TABLE IF NOT EXISTS video_subjects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      video_id UUID REFERENCES videos(id) ON DELETE CASCADE NOT NULL,
      subject_id UUID REFERENCES project_subjects(id) ON DELETE CASCADE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(video_id, subject_id)
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_video_subjects_video ON video_subjects(video_id)`).catch(() => {})

  await query(`
    CREATE TABLE IF NOT EXISTS user_asset_groups (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id),
      group_id VARCHAR(100) NOT NULL,
      group_type VARCHAR(20) NOT NULL,
      name VARCHAR(200),
      shared BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_asset_groups_user_group
    ON user_asset_groups (user_id, group_id) WHERE user_id IS NOT NULL
  `).catch(() => {})

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_asset_groups_shared_group
    ON user_asset_groups (group_id) WHERE shared = TRUE
  `).catch(() => {})
}

module.exports = { query, initDB, pool }
