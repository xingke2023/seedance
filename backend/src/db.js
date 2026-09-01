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

  // ---- Stripe 订阅 ----
  // 一个用户一个 Stripe customer，复用它才能在 Billing Portal 里看到历史订单
  await query(`
    CREATE TABLE IF NOT EXISTS billing_customers (
      user_id INT PRIMARY KEY REFERENCES users(id),
      stripe_customer_id VARCHAR(64) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) NOT NULL,
      stripe_subscription_id VARCHAR(64) UNIQUE NOT NULL,
      stripe_customer_id VARCHAR(64) NOT NULL,
      stripe_price_id VARCHAR(64),
      plan_key VARCHAR(32),
      status VARCHAR(32),
      current_period_end TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_billing_subs_user ON billing_subscriptions(user_id)`)

  // 每条 Stripe 事件只处理一次：主键就是去重锁。同时兼作到账流水
  await query(`
    CREATE TABLE IF NOT EXISTS billing_events (
      stripe_event_id VARCHAR(64) PRIMARY KEY,
      type VARCHAR(64),
      user_id INT,
      credits_granted INT DEFAULT 0,
      amount INT,
      currency VARCHAR(10),
      source_id VARCHAR(64),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await query(`ALTER TABLE billing_events RENAME COLUMN invoice_id TO source_id`).catch(() => {})
  await query(`ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS source_id VARCHAR(64)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_billing_events_user ON billing_events(user_id, created_at DESC)`)
  // 同一笔款只能入账一次。source_id 是发票 ID（订阅）或 Checkout Session ID（次数包）：
  // invoice.paid 和 invoice.payment_succeeded 是两条不同事件、会为同一张发票各来一次；
  // 次数包的 checkout.session.completed 和 async_payment_succeeded 同理。
  // 事件 ID 去重拦不住这种，得按付款对象去重
  await query(`DROP INDEX IF EXISTS idx_billing_events_invoice`)
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_events_source
                 ON billing_events(source_id) WHERE source_id IS NOT NULL`)

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
