-- =============================================================================
-- Floor Plan Platform v2 — Project Hierarchy + Photo & Diagram View (ร่างเพื่ออนุมัติ — ยังไม่ใช้งานจริง)
-- PostgreSQL 16 (ใช้กับ Supabase ได้) · ไฟล์จริงอยู่ใน Object Storage แบบ private (R2/S3) ไม่เก็บใน DB
--
-- ฉบับแก้ครั้งที่ 2 (ตามคำตัดสิน 20 ต.ค. 2569): Site เป็นระดับเสริม · แยก Monitoring Point / Device / Asset / Metric
--   · บทบาท 6 แบบ + ผู้ดูแลสมาชิกระดับองค์กร · กติกาเปลี่ยนสถานะติดตั้งตามบทบาท (AI/บัญชีระบบอนุมัติหรือ Commission ไม่ได้)
--   · ประวัติค่าวัด/Alarm/การรับทราบ ผูกกับ Monitoring Point (เปลี่ยน Device แล้วไม่หลุด)
--
-- หลักการ
--  1) ทุก Entity มี UUID ถาวร (id) + รหัสที่คนอ่าน (code) unique ต่อโครงการ — ความสัมพันธ์ใช้ UUID เท่านั้น
--  2) Project Isolation ระดับฐานข้อมูล: ทุกตารางลูกมี project_id และ FK แบบคู่ (project_id, id)
--     → อ้างข้ามโครงการไม่ได้แม้โค้ดฝั่ง API ผิด · RLS กรองตามสมาชิกโครงการทุกคำขอ
--  3) ตำแหน่งบนทุกมุมมอง (ผัง 2D, โมเดล 3D, รูปถ่าย, แผนภาพ) = placements ของ Entity เดียวกัน
--     → จุดเดียวกันเปิดจาก Photo / 2D / 3D ได้ id เดียวกัน = ข้อมูล กราฟ Alarm ชุดเดียวกัน
--  4) ไฟล์ (ผัง โมเดล รูป) มีเวอร์ชันจาก SHA-256 ของเนื้อหา · placement จำเวอร์ชันที่ใช้วาง → เปลี่ยนไฟล์ = needs_remapping
--  5) Monitoring Point (จุดตรวจวัด) = ตำแหน่งที่วัด มี UUID ถาวร · Device (เครื่องเซนเซอร์/เกตเวย์) = ฮาร์ดแวร์ที่เปลี่ยนได้
--     · Asset (อุปกรณ์ที่ถูกวัด เช่น ปั๊ม) · Metric (ค่าวัดของจุด) — เป็น 4 Entity แยกกัน ไม่รวมกัน
--     ค่าวัด Alarm และการรับทราบอ้างด้วย (project_id, point_id, metric_id) · device_id เก็บเป็นแหล่งที่มาเท่านั้น
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

-- ผู้ใช้ปัจจุบันของคำขอ: API ตั้งค่าหลังตรวจ session (SET LOCAL app.user_id = '…') — ห้ามรับจาก Frontend ตรง ๆ
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ---------------------------------------------------------------- ผู้ใช้ / องค์กร / สิทธิ์
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE,
  display_name  text NOT NULL,
  kind          text NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'service')), -- service = worker/AI/automation
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace_id  uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), -- namespace ของ UUID v5 ตอนย้ายข้อมูลเดิม (ไม่เปลี่ยนตลอดอายุ)
  code          text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code            text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  name            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'Asia/Bangkok',
  data_mode       text NOT NULL DEFAULT 'demo' CHECK (data_mode IN ('demo', 'live', 'mixed')),
  -- ค่าตั้งต้นของโครงการ เช่น defaultPointInstallStatus (Fortune Demo = installed, ทั่วไป = proposed)
  settings        jsonb NOT NULL DEFAULT '{"defaultPointInstallStatus":"proposed"}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  UNIQUE (organization_id, code)
);

CREATE TABLE project_members (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- viewer = ดูอย่างเดียว · client_reviewer = ดู + แสดงความเห็น · technical_editor = สร้าง/แก้ลำดับชั้น จุด อุปกรณ์ รูป Hotspot
  -- installer = บันทึกการติดตั้ง/เปลี่ยน Device · client_approver = อนุมัติ/ไม่อนุมัติ และเผยแพร่มุมมอง
  -- commissioning_engineer = ส่งมอบใช้งาน (Commission) / ปลดระวาง · ผู้ใช้หนึ่งคนมีได้หลายบทบาท (หลายแถว)
  role        text NOT NULL CHECK (role IN ('viewer', 'client_reviewer', 'technical_editor', 'installer', 'client_approver', 'commissioning_engineer')),
  PRIMARY KEY (project_id, user_id, role)
);

-- ผู้ดูแลสมาชิกขององค์กร: เพิ่ม/ลบสมาชิกโครงการได้ แต่ไม่ได้สิทธิ์อนุมัติ/Commission โดยอัตโนมัติ (ต้องมีบทบาทในโครงการ)
CREATE TABLE organization_admins (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (organization_id, user_id)
);

CREATE OR REPLACE FUNCTION app.is_member(p uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p AND m.user_id = app.current_user_id()) $$;

CREATE OR REPLACE FUNCTION app.has_role(p uuid, roles text[]) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p AND m.user_id = app.current_user_id() AND m.role = ANY (roles)) $$;

-- ผู้ใช้ปัจจุบันเป็นคน (ไม่ใช่ AI/บัญชีระบบ)
CREATE OR REPLACE FUNCTION app.is_human() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = app.current_user_id() AND u.kind = 'human') $$;

-- ---------------------------------------------------------------- ลำดับชั้นพื้นที่: (Site) → Building → Floor → Space
-- Site เป็นระดับเสริม: อาคารอยู่ใต้ Site หรือใต้โครงการโดยตรงก็ได้ · โครงการที่มี Site ไม่เกิน 1 แห่ง UI ซ่อนระดับนี้ (project_hierarchy_settings)
CREATE TABLE sites (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  name        text NOT NULL,
  address     text,
  geo         jsonb,                                  -- { lat, lng } ตัวเลือก (ไม่บังคับ)
  PRIMARY KEY (project_id, id),
  UNIQUE (id),
  UNIQUE (project_id, code)
);

CREATE TABLE buildings (
  project_id         uuid NOT NULL,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id            uuid,                                -- ระดับเสริม (NULL = อาคารอยู่ใต้โครงการโดยตรง)
  code               text NOT NULL,
  name               text NOT NULL,
  coordinate_system  jsonb NOT NULL DEFAULT '{"version":"crs-1","axes":"x-right,z-south,y-up","unit":"model-unit"}',
  PRIMARY KEY (project_id, id),
  UNIQUE (id),
  UNIQUE (project_id, code),
  FOREIGN KEY (project_id, site_id) REFERENCES sites (project_id, id)
);

CREATE TABLE floors (
  project_id        uuid NOT NULL,
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  building_id       uuid NOT NULL,
  code              text NOT NULL,                        -- 'G', '5', '11'
  name              text NOT NULL,
  sort_order        integer NOT NULL,
  elevation         double precision NOT NULL,
  height            double precision NOT NULL CHECK (height > 0),
  plan_transform    double precision[] NOT NULL CHECK (array_length(plan_transform, 1) = 6), -- affine2d [a,b,c,d,e,f]
  plan_view_id      uuid,                                 -- มุมมองผัง 2D ปัจจุบัน (views.kind = 'plan')
  model_view_id     uuid,                                 -- มุมมองโมเดล 3D ปัจจุบัน (views.kind = 'model')
  PRIMARY KEY (project_id, id),
  UNIQUE (id),
  UNIQUE (project_id, building_id, code),
  FOREIGN KEY (project_id, building_id) REFERENCES buildings (project_id, id)
);

-- Space = โซน / ห้อง / ร้าน / ทางเดิน ซ้อนกันได้ (โซนขาย > ห้อง) อยู่บนชั้นเดียว
CREATE TABLE spaces (
  project_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  floor_id    uuid NOT NULL,
  parent_id   uuid,
  code        text NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('zone', 'room', 'shop', 'corridor', 'plant', 'electrical', 'office', 'service', 'parking', 'other')),
  outline     jsonb,                                 -- รูปทรงบนผัง [[u,v],…] (ตัวเลือก) — มาจาก rooms-*.json/Importer
  PRIMARY KEY (project_id, id),
  UNIQUE (id),
  UNIQUE (project_id, code),
  FOREIGN KEY (project_id, floor_id) REFERENCES floors (project_id, id),
  FOREIGN KEY (project_id, parent_id) REFERENCES spaces (project_id, id)
);

-- ---------------------------------------------------------------- Asset · Monitoring Point · Metric · Device (4 Entity แยกกัน)
CREATE TABLE asset_types (                               -- Asset Catalog (โมดูลที่ 4 ขยายต่อ: รุ่น สเปก ราคา)
  id           text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]{1,31}$'), -- pump, tank, pit, ahu, panel, chiller …
  name         text NOT NULL,
  default_visual jsonb                                   -- แบบภาพ 3D/ไอคอน 2D/Hotspot ตั้งต้น
);

CREATE TABLE assets (
  project_id    uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  floor_id      uuid NOT NULL,
  space_id      uuid,
  type_id       text NOT NULL REFERENCES asset_types(id),
  code          text NOT NULL,                          -- FRT-DEMO-PUMP-001 · รหัสจริงเมื่อได้รับ (แก้ code ได้ UUID ไม่เปลี่ยน)
  name          text NOT NULL,
  is_demo       boolean NOT NULL DEFAULT false,
  install_status text NOT NULL DEFAULT 'proposed' CHECK (install_status IN ('draft','proposed','pending_approval','approved','installed','commissioned','rejected','decommissioned')),
  visual        jsonb,                                  -- { kind, offset:{x,z} }
  PRIMARY KEY (project_id, id),
  UNIQUE (id),
  UNIQUE (project_id, code),
  FOREIGN KEY (project_id, floor_id) REFERENCES floors (project_id, id),
  FOREIGN KEY (project_id, space_id) REFERENCES spaces (project_id, id)
);

-- Monitoring Point = จุดตรวจวัด (ตำแหน่งที่วัด ที่คนเห็นและมีประวัติ) — UUID ถาวร
-- ไม่ใช่เครื่องเซนเซอร์: เครื่องอยู่ในตาราง devices และเปลี่ยนได้โดยประวัติ กราฟ Alarm ของจุดคงอยู่
CREATE TABLE monitoring_points (
  project_id     uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  floor_id       uuid NOT NULL,
  space_id       uuid,
  code           text NOT NULL,                         -- P-005, WL-001
  name           text NOT NULL,
  system         text NOT NULL,
  is_demo        boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  install_status text NOT NULL DEFAULT 'proposed' CHECK (install_status IN ('draft','proposed','pending_approval','approved','installed','commissioned','rejected','decommissioned')),
  PRIMARY KEY (project_id, id),
  UNIQUE (id),
  UNIQUE (project_id, code),
  FOREIGN KEY (project_id, floor_id) REFERENCES floors (project_id, id),
  FOREIGN KEY (project_id, space_id) REFERENCES spaces (project_id, id)
);

CREATE TABLE metrics (
  project_id   uuid NOT NULL,
  point_id     uuid NOT NULL,
  id           text NOT NULL,                           -- 'temp', 'level' (ภายในจุด)
  source_key   text NOT NULL,                           -- คีย์ของค่าในข้อมูลที่อุปกรณ์ส่ง
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('numeric', 'discrete')),
  unit         text,
  spec         jsonb NOT NULL DEFAULT '{}',             -- plausible, staleAfterSec, states, gauge …
  PRIMARY KEY (project_id, point_id, id),
  UNIQUE (project_id, point_id, source_key),
  FOREIGN KEY (project_id, point_id) REFERENCES monitoring_points (project_id, id) ON DELETE CASCADE
);

-- Device = เครื่องจริง (เซนเซอร์/เกตเวย์ เช่น GW-02) · source_key = รหัสที่เครื่องส่งมา · token เก็บเฉพาะ hash (ผูกเครื่อง+โครงการ)
CREATE TABLE devices (
  project_id    uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  source_key    text NOT NULL,
  model         text,
  serial_no     text,
  token_hash    text,                                   -- argon2/sha256 ของ Device Token (ไม่เก็บค่าจริง)
  token_rotated_at timestamptz,
  PRIMARY KEY (project_id, id),
  UNIQUE (id),
  UNIQUE (project_id, source_key)
);

-- ประวัติการติดตั้ง Device ที่ Monitoring Point (เปลี่ยนเครื่อง = ปิดแถวเดิม เปิดแถวใหม่ · ประวัติค่าวัดยังเป็นของจุดเดิม)
CREATE TABLE device_installations (
  project_id   uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL,
  point_id     uuid NOT NULL,
  installed_at timestamptz NOT NULL,
  removed_at   timestamptz,
  installed_by uuid REFERENCES users(id),
  removed_by   uuid REFERENCES users(id),
  note         text,
  CHECK (removed_at IS NULL OR removed_at > installed_at),
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, device_id) REFERENCES devices (project_id, id),
  FOREIGN KEY (project_id, point_id) REFERENCES monitoring_points (project_id, id)
);
-- อุปกรณ์หนึ่งตัวติดได้ทีละจุด และจุดหนึ่งมีอุปกรณ์ที่ใช้งานได้ทีละตัว
CREATE UNIQUE INDEX device_installations_active_device ON device_installations (project_id, device_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX device_installations_active_point ON device_installations (project_id, point_id) WHERE removed_at IS NULL;

-- ความสัมพันธ์ Monitoring Point–Asset ที่เดียว (บทบาท level/run/current/temperature …)
CREATE TABLE bindings (
  project_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL,
  point_id    uuid NOT NULL,
  metric_id   text NOT NULL,
  role        text NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, asset_id, role, point_id, metric_id),
  FOREIGN KEY (project_id, asset_id) REFERENCES assets (project_id, id),
  FOREIGN KEY (project_id, point_id, metric_id) REFERENCES metrics (project_id, point_id, id)
);
CREATE UNIQUE INDEX bindings_single_role ON bindings (project_id, asset_id, role) WHERE role IN ('level', 'run');

-- ---------------------------------------------------------------- ไฟล์และมุมมอง (Plan / Model / Photo / Diagram)
CREATE TABLE media_files (
  project_id    uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('plan', 'model', 'photo', 'diagram', 'document')),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),  -- เวอร์ชัน = เนื้อหาไฟล์ (ไม่ใช่ชื่อ/ขนาด)
  storage_key   text NOT NULL,                          -- private bucket: projects/<projectId>/media/<sha256>.<ext>
  content_type  text NOT NULL CHECK (content_type IN ('image/webp', 'image/jpeg', 'image/png', 'model/gltf-binary', 'application/pdf')),
  width_px      integer,
  height_px     integer,
  bytes         bigint NOT NULL CHECK (bytes > 0 AND bytes <= 52428800),  -- ≤ 50 MB ต่อไฟล์ (รูป/ผัง)
  variants      jsonb NOT NULL DEFAULT '{}',            -- { "480": key, "1600": key, "4096": key } สร้างโดย worker (ตัด EXIF/GPS)
  scan_status   text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'rejected')),
  uploaded_by   uuid REFERENCES users(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  UNIQUE (id),
  UNIQUE (project_id, sha256)
);

-- View = ภาพที่ใช้ดูข้อมูล: ผังชั้น 2D, โมเดล 3D, รูปห้อง/เครื่องจักร, แผนภาพระบบ (one-line, P&ID)
CREATE TABLE views (
  project_id    uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('plan', 'model', 'photo', 'diagram')),
  title         text NOT NULL,
  subject_type  text NOT NULL CHECK (subject_type IN ('floor', 'space', 'asset')),
  subject_id    uuid NOT NULL,                          -- ตรวจด้วย trigger ให้อยู่ในโครงการเดียวกัน
  file_id       uuid NOT NULL,                          -- เวอร์ชันไฟล์ปัจจุบันของมุมมอง
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review_required', 'approved', 'published', 'archived')),
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  UNIQUE (id),
  FOREIGN KEY (project_id, file_id) REFERENCES media_files (project_id, id)
);

ALTER TABLE floors
  ADD FOREIGN KEY (project_id, plan_view_id) REFERENCES views (project_id, id),
  ADD FOREIGN KEY (project_id, model_view_id) REFERENCES views (project_id, id);

-- Placement = ตำแหน่งของ Entity บนมุมมองหนึ่ง (หมุดบนผัง, จุดใน 3D, Hotspot บนรูป)
-- จุดเดียว (monitoring_points.id เดียว) มีได้หลาย placement — ทุกมุมมองเปิดข้อมูลชุดเดียวกัน
CREATE TABLE placements (
  project_id       uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  view_id          uuid NOT NULL,
  target_type      text NOT NULL CHECK (target_type IN ('point', 'asset', 'space')),
  point_id         uuid,
  asset_id         uuid,
  space_id         uuid,
  -- รูปทรงในพิกัดของมุมมอง: ภาพ/ผัง = u,v ปกติ 0–1 ของภาพ · 3D = x,y,z ใน Building CRS
  shape            text NOT NULL CHECK (shape IN ('pin', 'rect', 'polygon', 'xyz')),
  geometry         jsonb NOT NULL,                      -- pin {u,v} · rect {u,v,w,h} · polygon {pts:[[u,v],…]} · xyz {x,y,z}
  label_mode       text NOT NULL DEFAULT 'value' CHECK (label_mode IN ('value', 'status', 'name', 'icon')),
  metric_id        text,                                -- ค่าที่แสดงบน Hotspot (ไม่ระบุ = ค่าหลักของจุด)
  mapping_status   text NOT NULL DEFAULT 'mapped' CHECK (mapping_status IN ('mapped', 'unanchored', 'needs_remapping')),
  remap_reasons    text[] NOT NULL DEFAULT '{}',
  resolved_file_sha256 text NOT NULL,                   -- เวอร์ชันไฟล์ตอนวาง → ไฟล์ของมุมมองเปลี่ยน = needs_remapping (image-changed)
  created_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, view_id) REFERENCES views (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, point_id) REFERENCES monitoring_points (project_id, id),
  FOREIGN KEY (project_id, asset_id) REFERENCES assets (project_id, id),
  FOREIGN KEY (project_id, space_id) REFERENCES spaces (project_id, id),
  CHECK ((target_type = 'point') = (point_id IS NOT NULL) AND (target_type = 'asset') = (asset_id IS NOT NULL) AND (target_type = 'space') = (space_id IS NOT NULL)),
  CHECK (shape <> 'xyz' OR (geometry ? 'x' AND geometry ? 'y' AND geometry ? 'z')),
  CHECK (shape <> 'pin' OR ((geometry->>'u')::float8 BETWEEN 0 AND 1 AND (geometry->>'v')::float8 BETWEEN 0 AND 1)),
  CHECK (shape <> 'rect' OR ((geometry->>'u')::float8 BETWEEN 0 AND 1 AND (geometry->>'v')::float8 BETWEEN 0 AND 1
                              AND (geometry->>'w')::float8 > 0 AND (geometry->>'h')::float8 > 0
                              AND (geometry->>'u')::float8 + (geometry->>'w')::float8 <= 1 AND (geometry->>'v')::float8 + (geometry->>'h')::float8 <= 1))
);
-- จุดหนึ่งมี placement ได้หนึ่งตำแหน่งต่อมุมมอง (แก้ = ย้าย ไม่ใช่เพิ่มซ้ำ)
CREATE UNIQUE INDEX placements_one_per_view_point ON placements (project_id, view_id, point_id) WHERE point_id IS NOT NULL;
CREATE UNIQUE INDEX placements_one_per_view_asset ON placements (project_id, view_id, asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX placements_by_point ON placements (project_id, point_id) WHERE point_id IS NOT NULL;

-- subject ของ View ต้องอยู่ในโครงการเดียวกัน (FK แบบ polymorphic ทำด้วย trigger)
CREATE OR REPLACE FUNCTION app.check_view_subject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    (NEW.subject_type = 'floor' AND EXISTS (SELECT 1 FROM floors f WHERE f.project_id = NEW.project_id AND f.id = NEW.subject_id)) OR
    (NEW.subject_type = 'space' AND EXISTS (SELECT 1 FROM spaces s WHERE s.project_id = NEW.project_id AND s.id = NEW.subject_id)) OR
    (NEW.subject_type = 'asset' AND EXISTS (SELECT 1 FROM assets a WHERE a.project_id = NEW.project_id AND a.id = NEW.subject_id))
  ) THEN
    RAISE EXCEPTION 'view subject % % is not in project %', NEW.subject_type, NEW.subject_id, NEW.project_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER views_subject_check BEFORE INSERT OR UPDATE OF subject_type, subject_id, project_id ON views
  FOR EACH ROW EXECUTE FUNCTION app.check_view_subject();

-- เปลี่ยนไฟล์ของมุมมอง → placement ที่วางบนไฟล์เดิมเป็น needs_remapping (ไม่ลบ ไม่ซ่อน)
CREATE OR REPLACE FUNCTION app.flag_remap_on_file_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE new_sha text;
BEGIN
  IF NEW.file_id IS DISTINCT FROM OLD.file_id THEN
    SELECT sha256 INTO new_sha FROM media_files WHERE project_id = NEW.project_id AND id = NEW.file_id;
    UPDATE placements p SET mapping_status = 'needs_remapping',
      remap_reasons = (SELECT array_agg(DISTINCT r) FROM unnest(p.remap_reasons || ARRAY[CASE WHEN NEW.kind = 'plan' THEN 'plan-changed' WHEN NEW.kind = 'model' THEN 'model-changed' ELSE 'image-changed' END]) r),
      updated_at = now()
    WHERE p.project_id = NEW.project_id AND p.view_id = NEW.id AND p.resolved_file_sha256 <> new_sha;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER views_file_change AFTER UPDATE OF file_id ON views FOR EACH ROW EXECUTE FUNCTION app.flag_remap_on_file_change();

-- ---------------------------------------------------------------- ประวัติค่าวัด · Alarm · การรับทราบ (ผูกกับ Monitoring Point ไม่ใช่ Device)
-- เปลี่ยน Device แล้วกราฟ/Alarm/การรับทราบของจุดยังต่อเนื่อง · device_id เก็บเป็นแหล่งที่มา (ตรวจย้อนหลังได้ว่าค่ามาจากเครื่องไหน)
-- เขียนโดย Ingest Service (role แยก ไม่ใช่ app_user) เท่านั้น · ใน Production แบ่ง partition ตามเดือน
CREATE TABLE telemetry_samples (
  project_id   uuid NOT NULL,
  point_id     uuid NOT NULL,
  metric_id    text NOT NULL,
  observed_at  timestamptz NOT NULL,
  value_num    double precision,
  value_text   text,
  device_id    uuid,
  received_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((value_num IS NULL) <> (value_text IS NULL)),
  PRIMARY KEY (project_id, point_id, metric_id, observed_at),
  FOREIGN KEY (project_id, point_id, metric_id) REFERENCES metrics (project_id, point_id, id),
  FOREIGN KEY (project_id, device_id) REFERENCES devices (project_id, id)
);

CREATE TABLE alarm_episodes (
  project_id    uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  point_id      uuid NOT NULL,
  metric_id     text NOT NULL,
  rule_code     text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('warning', 'critical')),
  opened_at     timestamptz NOT NULL,
  recovered_at  timestamptz,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, point_id, metric_id) REFERENCES metrics (project_id, point_id, id)
);

CREATE TABLE alarm_acknowledgements (
  project_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  episode_id  uuid NOT NULL,
  by_user     uuid NOT NULL REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now(),
  note        text CHECK (length(note) <= 1000),
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, episode_id) REFERENCES alarm_episodes (project_id, id)
);

-- ความเห็นของผู้ตรวจ (Client Reviewer ฯลฯ) ต่อ Entity/มุมมอง — ไม่เปลี่ยนข้อมูล ไม่อนุมัติ
CREATE TABLE review_comments (
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL CHECK (entity_type IN ('site', 'building', 'floor', 'space', 'asset', 'point', 'view', 'placement')),
  entity_id    uuid NOT NULL,
  author_id    uuid NOT NULL REFERENCES users(id),
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  resolved     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

-- ---------------------------------------------------------------- Audit
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  project_id  uuid REFERENCES projects(id),
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,                            -- view.publish, install_status, device.replace, access.denied …
  entity_type text,
  entity_id   uuid,
  detail      jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- กติกาเปลี่ยนสถานะติดตั้งตามบทบาท (Monitoring Point และ Asset)
--   ร่าง/เสนอ/รออนุมัติ ← technical_editor
--   อนุมัติแล้ว/ไม่อนุมัติ ← client_approver (คนเท่านั้น · จาก "รออนุมัติ")
--   ติดตั้งแล้ว ← installer (จาก "อนุมัติแล้ว" · Monitoring Point ต้องมี Device ที่ติดอยู่)
--   ส่งมอบใช้งานแล้ว (Commissioned) ← commissioning_engineer (คนเท่านั้น · จาก "ติดตั้งแล้ว")
--   ปลดระวาง ← commissioning_engineer (คนเท่านั้น)
-- ทางเดียวที่ข้ามกติกาได้: งานย้ายข้อมูลเดิม (Fortune) ที่รันโดย role เจ้าของ schema และตั้ง app.lifecycle_bypass = 'migration'
--   (app_user ตั้งค่านี้แล้วก็ข้ามไม่ได้) — บันทึก audit ทุกครั้ง
CREATE OR REPLACE FUNCTION app.guard_install_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_s text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.install_status ELSE NULL END;
  new_s text := NEW.install_status;
  ok boolean := false;
  migrating boolean := current_setting('app.lifecycle_bypass', true) = 'migration' AND current_user <> 'app_user';
BEGIN
  IF TG_OP = 'UPDATE' AND old_s = new_s THEN RETURN NEW; END IF;
  IF migrating THEN
    ok := true;
  ELSIF new_s IN ('draft', 'proposed', 'pending_approval') THEN
    ok := app.has_role(NEW.project_id, ARRAY['technical_editor']) AND (old_s IS NULL OR old_s IN ('draft', 'proposed', 'pending_approval', 'rejected'));
  ELSIF new_s IN ('approved', 'rejected') THEN
    ok := old_s = 'pending_approval' AND app.is_human() AND app.has_role(NEW.project_id, ARRAY['client_approver']);
  ELSIF new_s = 'installed' THEN
    ok := old_s = 'approved' AND app.has_role(NEW.project_id, ARRAY['installer'])
      AND (TG_TABLE_NAME <> 'monitoring_points' OR EXISTS (SELECT 1 FROM device_installations d WHERE d.project_id = NEW.project_id AND d.point_id = NEW.id AND d.removed_at IS NULL));
  ELSIF new_s = 'commissioned' THEN
    ok := old_s = 'installed' AND app.is_human() AND app.has_role(NEW.project_id, ARRAY['commissioning_engineer']);
  ELSIF new_s = 'decommissioned' THEN
    ok := old_s IN ('installed', 'commissioned') AND app.is_human() AND app.has_role(NEW.project_id, ARRAY['commissioning_engineer']);
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'install status % -> % not allowed for this user/role', coalesce(old_s, '(new)'), new_s USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO audit_log (project_id, actor_id, action, entity_type, entity_id, detail)
    VALUES (NEW.project_id, app.current_user_id(), 'install_status', TG_TABLE_NAME, NEW.id, jsonb_build_object('from', old_s, 'to', new_s, 'migration', migrating));
  RETURN NEW;
END $$;
CREATE TRIGGER monitoring_points_install_guard BEFORE INSERT OR UPDATE OF install_status ON monitoring_points FOR EACH ROW EXECUTE FUNCTION app.guard_install_status();
CREATE TRIGGER assets_install_guard BEFORE INSERT OR UPDATE OF install_status ON assets FOR EACH ROW EXECUTE FUNCTION app.guard_install_status();

-- อนุมัติ/เผยแพร่มุมมอง (รูป/แผนภาพ/ผัง): client_approver ที่เป็นคนเท่านั้น และ approved_by ต้องเป็นผู้ใช้ปัจจุบัน
CREATE OR REPLACE FUNCTION app.guard_view_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('approved', 'published') AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (app.is_human() AND app.has_role(NEW.project_id, ARRAY['client_approver']) AND NEW.approved_by = app.current_user_id()) THEN
      RAISE EXCEPTION 'approval/publication requires a human client approver' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.approved_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER views_approval_guard BEFORE UPDATE OF status ON views FOR EACH ROW EXECUTE FUNCTION app.guard_view_approval();

-- รับทราบ Alarm: คนเท่านั้น และต้องบันทึกในนามตัวเอง
CREATE OR REPLACE FUNCTION app.guard_ack() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (app.is_human() AND NEW.by_user = app.current_user_id()) THEN
    RAISE EXCEPTION 'acknowledgement must be made by the signed-in person' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alarm_ack_guard BEFORE INSERT ON alarm_acknowledgements FOR EACH ROW EXECUTE FUNCTION app.guard_ack();

-- ---------------------------------------------------------------- Row-Level Security (ทุกตารางของโครงการ)
-- API เชื่อมต่อด้วย role "app_user" (ไม่ใช่เจ้าของ) → RLS บังคับเสมอ · Ingest/Worker ใช้ role แยกที่จำกัดตารางเอง
-- ไม่มีนโยบาย DELETE ให้ผู้ใช้โครงการ = ลบไม่ได้ (ใช้ archived/ปลดระวางแทน เพื่อรักษาประวัติ)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites','buildings','floors','spaces','assets','monitoring_points','metrics','devices','device_installations','bindings','media_files','views','placements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app.is_member(project_id))', t || '_read', t);
  END LOOP;
  -- โครงสร้าง จุด อุปกรณ์ รูป Hotspot: technical_editor (สถานะติดตั้งตรวจแยกด้วย trigger ตามบทบาท)
  FOREACH t IN ARRAY ARRAY['sites','buildings','floors','spaces','assets','monitoring_points','metrics','bindings','media_files','views','placements'] LOOP
    EXECUTE format($p$CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app.has_role(project_id, ARRAY['technical_editor']))$p$, t || '_insert', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR UPDATE USING (app.has_role(project_id, ARRAY['technical_editor','installer','client_approver','commissioning_engineer'])) WITH CHECK (app.has_role(project_id, ARRAY['technical_editor','installer','client_approver','commissioning_engineer']))$p$, t || '_update', t);
  END LOOP;
  -- Device และประวัติการติดตั้ง: installer (+ technical_editor ลงทะเบียนเครื่อง)
  FOREACH t IN ARRAY ARRAY['devices','device_installations'] LOOP
    EXECUTE format($p$CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app.has_role(project_id, ARRAY['installer','technical_editor']))$p$, t || '_insert', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR UPDATE USING (app.has_role(project_id, ARRAY['installer'])) WITH CHECK (app.has_role(project_id, ARRAY['installer']))$p$, t || '_update', t);
  END LOOP;
  -- ค่าวัด/Alarm: อ่านได้ทุกสมาชิก · เขียนโดย Ingest Service เท่านั้น (ไม่มีนโยบาย INSERT สำหรับ app_user)
  FOREACH t IN ARRAY ARRAY['telemetry_samples','alarm_episodes','alarm_acknowledgements','review_comments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app.is_member(project_id))', t || '_read', t);
  END LOOP;
END $$;
CREATE POLICY ack_insert ON alarm_acknowledgements FOR INSERT
  WITH CHECK (app.has_role(project_id, ARRAY['technical_editor','installer','client_approver','commissioning_engineer']));
CREATE POLICY review_insert ON review_comments FOR INSERT
  WITH CHECK (author_id = app.current_user_id() AND app.has_role(project_id, ARRAY['client_reviewer','technical_editor','installer','client_approver','commissioning_engineer']));
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_read ON projects FOR SELECT USING (app.is_member(id));
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_log FOR SELECT USING (app.has_role(project_id, ARRAY['client_approver','commissioning_engineer']));
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (actor_id IS NOT DISTINCT FROM app.current_user_id());

-- ---------------------------------------------------------------- มุมมองช่วยอ่าน
-- จุดนี้ปรากฏที่ไหนบ้าง (Photo / 2D / 3D)
CREATE VIEW point_appearances WITH (security_invoker = true) AS
  SELECT p.project_id, p.point_id, p.view_id, v.kind AS view_kind, v.title, p.shape, p.geometry, p.mapping_status, p.remap_reasons
  FROM placements p JOIN views v ON v.project_id = p.project_id AND v.id = p.view_id
  WHERE p.point_id IS NOT NULL AND v.status <> 'archived';

-- Site เป็นระดับเสริม: แสดงใน UI เมื่อโครงการมีมากกว่า 1 แห่ง
CREATE VIEW project_hierarchy_settings WITH (security_invoker = true) AS
  SELECT pr.id AS project_id, count(s.id) AS site_count, count(s.id) > 1 AS show_site_level
  FROM projects pr LEFT JOIN sites s ON s.project_id = pr.id
  GROUP BY pr.id;

-- ประวัติค่าวัดของจุดพร้อมเครื่องที่ส่ง (ข้ามการเปลี่ยน Device)
CREATE VIEW point_history WITH (security_invoker = true) AS
  SELECT t.project_id, t.point_id, t.metric_id, t.observed_at, t.value_num, t.value_text, t.device_id, d.source_key AS device_source_key
  FROM telemetry_samples t LEFT JOIN devices d ON d.project_id = t.project_id AND d.id = t.device_id;
