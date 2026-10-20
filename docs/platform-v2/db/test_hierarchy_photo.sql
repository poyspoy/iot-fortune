-- ทดสอบ schema บน PostgreSQL 16 (ฐานข้อมูลว่าง):
--   psql -v ON_ERROR_STOP=1 -f hierarchy_photo.sql -f test_hierarchy_photo.sql
-- ทุกข้อบันทึก PASS/FAIL ลงตาราง test_results แล้วพิมพ์สรุป · ข้อที่ "ต้องถูกปฏิเสธ" ดักข้อผิดพลาดใน DO block
\set ON_ERROR_STOP 1
SET client_min_messages = warning;

CREATE ROLE app_user NOLOGIN;
GRANT USAGE ON SCHEMA app, public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_user;

CREATE TABLE test_results (n serial, name text, ok boolean, detail text);
GRANT ALL ON test_results TO app_user; GRANT ALL ON SEQUENCE test_results_n_seq TO app_user;
CREATE FUNCTION t(name text, ok boolean, detail text DEFAULT '') RETURNS void LANGUAGE sql AS
  $$ INSERT INTO test_results (name, ok, detail) VALUES (name, ok, detail) $$;
GRANT EXECUTE ON FUNCTION t TO app_user;
-- ทำงานในนามผู้ใช้ (เหมือน API ตั้งค่าหลังตรวจ session)
CREATE FUNCTION as_user(u text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('app.user_id', u, false) $$;
GRANT EXECUTE ON FUNCTION as_user TO app_user;

-- ---------------------------------------------------------------- ข้อมูลทดสอบ (เจ้าของ schema = งานย้ายข้อมูล Fortune)
SET app.lifecycle_bypass = 'migration';
INSERT INTO users (id, email, display_name, kind) VALUES
  ('00000000-0000-4000-8000-00000000000a', 'editor@example.com', 'Technical Editor (FRT)', 'human'),
  ('00000000-0000-4000-8000-00000000000b', 'b@example.com', 'ผู้ใช้โครงการอื่น (OFC)', 'human'),
  ('00000000-0000-4000-8000-00000000000c', 'approver@example.com', 'Client Approver (FRT)', 'human'),
  ('00000000-0000-4000-8000-00000000000e', 'cx@example.com', 'Commissioning Engineer (FRT)', 'human'),
  ('00000000-0000-4000-8000-000000000001', 'installer@example.com', 'Installer (FRT)', 'human'),
  ('00000000-0000-4000-8000-00000000000d', 'reviewer@example.com', 'Client Reviewer (FRT)', 'human'),
  ('00000000-0000-4000-8000-00000000000f', 'viewer@example.com', 'Viewer (FRT)', 'human'),
  ('00000000-0000-4000-8000-0000000000a1', null, 'AI / Import Worker', 'service');
INSERT INTO organizations (id, code, name) VALUES
  ('07fda8e7-e183-4174-9d18-9f16bcd92656', 'FRT-ORG', 'Fortune Demo Organization'),
  ('11111111-1111-4111-8111-111111111111', 'OTHER', 'องค์กรอื่น');
INSERT INTO projects (id, organization_id, code, name, settings) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', '07fda8e7-e183-4174-9d18-9f16bcd92656', 'FRT', 'IoT ฟอร์จูน (Pilot)', '{"defaultPointInstallStatus":"installed"}'),
  ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'OFC', 'สำนักงานตัวอย่าง (ไม่มี Site)', '{}'),
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'CMP', 'แคมปัสหลายไซต์', '{}');
INSERT INTO project_members VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', '00000000-0000-4000-8000-00000000000a', 'technical_editor'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', '00000000-0000-4000-8000-00000000000c', 'client_approver'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', '00000000-0000-4000-8000-00000000000e', 'commissioning_engineer'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', '00000000-0000-4000-8000-000000000001', 'installer'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', '00000000-0000-4000-8000-00000000000d', 'client_reviewer'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', '00000000-0000-4000-8000-00000000000f', 'viewer'),
  -- บัญชีระบบที่ได้บทบาทอนุมัติ/Commission โดยตั้งใจ (เพื่อพิสูจน์ว่า DB ยังปฏิเสธ)
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', '00000000-0000-4000-8000-0000000000a1', 'client_approver'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', '00000000-0000-4000-8000-0000000000a1', 'commissioning_engineer'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', '00000000-0000-4000-8000-0000000000a1', 'technical_editor'),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-00000000000b', 'technical_editor');
INSERT INTO asset_types (id, name) VALUES ('pump', 'ปั๊ม'), ('pit', 'บ่อ'), ('tank', 'ถัง');
INSERT INTO sites (project_id, id, code, name) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000001', 'FORTUNE-TOWN', 'ฟอร์จูนทาวน์'),
  ('33333333-3333-4333-8333-333333333333', 'c0000000-0000-4000-8000-000000000001', 'NORTH', 'วิทยาเขตเหนือ'),
  ('33333333-3333-4333-8333-333333333333', 'c0000000-0000-4000-8000-000000000002', 'SOUTH', 'วิทยาเขตใต้');
INSERT INTO buildings (project_id, id, site_id, code, name) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'c9189748-40c5-4bc9-bd62-c618508e9061', 'a0000000-0000-4000-8000-000000000001', 'FORTUNE-TOWN', 'ฟอร์จูนทาวน์'),
  ('22222222-2222-4222-8222-222222222222', 'b0000000-0000-4000-8000-000000000002', null, 'HQ-A', 'อาคาร A (ไม่มี Site)');
INSERT INTO floors (project_id, id, building_id, code, name, sort_order, elevation, height, plan_transform) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-0000000000f0', 'c9189748-40c5-4bc9-bd62-c618508e9061', 'G', 'ชั้น G', 0, 0, 0.6, '{12,0,-6,0,4.9,-2.45}'),
  ('22222222-2222-4222-8222-222222222222', 'b0000000-0000-4000-8000-0000000000f0', 'b0000000-0000-4000-8000-000000000002', '1', 'ชั้น 1', 1, 0, 3, '{20,0,-10,0,10,-5}');
INSERT INTO spaces (project_id, id, floor_id, code, name, kind) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000c01', 'a0000000-0000-4000-8000-0000000000f0', 'G-SVC', 'พื้นที่บริการ ชั้น G', 'service');
INSERT INTO assets (project_id, id, floor_id, space_id, type_id, code, name, is_demo, install_status, visual) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000a01', 'a0000000-0000-4000-8000-0000000000f0', 'a0000000-0000-4000-8000-000000000c01', 'pump', 'FRT-DEMO-PUMP-001', 'ปั๊มน้ำ (สาธิต)', true, 'installed', '{"kind":"pump","offset":{"x":-0.6,"z":0}}'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000a02', 'a0000000-0000-4000-8000-0000000000f0', 'a0000000-0000-4000-8000-000000000c01', 'pit', 'FRT-DEMO-PIT-001', 'บ่อสูบน้ำ (สาธิต)', true, 'installed', '{"kind":"pit","offset":{"x":0.42,"z":0}}');
INSERT INTO monitoring_points (project_id, id, floor_id, space_id, code, name, system, is_demo, install_status) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000b01', 'a0000000-0000-4000-8000-0000000000f0', 'a0000000-0000-4000-8000-000000000c01', 'WL-001', 'ระดับน้ำบ่อสูบน้ำ', 'water', true, 'installed'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000b03', 'a0000000-0000-4000-8000-0000000000f0', 'a0000000-0000-4000-8000-000000000c01', 'P-003', 'ปั๊มน้ำ (Monitoring Point)', 'water', true, 'installed'),
  ('22222222-2222-4222-8222-222222222222', 'b0000000-0000-4000-8000-000000000b01', 'b0000000-0000-4000-8000-0000000000f0', null, 'WL-001', 'รหัสเดียวกันแต่คนละโครงการ', 'water', false, 'proposed');
INSERT INTO metrics (project_id, point_id, id, source_key, name, kind, unit) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000b01', 'level', 'level', 'ระดับน้ำในบ่อ', 'numeric', 'cm'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000b03', 'run', 'run', 'สถานะเดิน/หยุด', 'discrete', null);
INSERT INTO bindings (project_id, asset_id, point_id, metric_id, role) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000a02', 'a0000000-0000-4000-8000-000000000b01', 'level', 'level'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000a01', 'a0000000-0000-4000-8000-000000000b03', 'run', 'run');
INSERT INTO devices (project_id, id, source_key, model) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000d01', 'GW-01', 'Level sensor (demo)'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000d02', 'GW-02', 'Level sensor (spare)');
INSERT INTO device_installations (project_id, device_id, point_id, installed_at) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000d01', 'a0000000-0000-4000-8000-000000000b01', '2026-10-01');
-- ประวัติค่าวัดและ Alarm จากเครื่องเดิม GW-01
INSERT INTO telemetry_samples (project_id, point_id, metric_id, observed_at, value_num, device_id) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000b01', 'level', '2026-10-05 10:00+07', 60.0, 'a0000000-0000-4000-8000-000000000d01'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000b01', 'level', '2026-10-05 10:05+07', 131.0, 'a0000000-0000-4000-8000-000000000d01');
INSERT INTO alarm_episodes (project_id, id, point_id, metric_id, rule_code, severity, opened_at) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-0000000000aa', 'a0000000-0000-4000-8000-000000000b01', 'level', 'R-001', 'warning', '2026-10-05 10:05+07');
INSERT INTO media_files (project_id, id, kind, sha256, storage_key, content_type, width_px, height_px, bytes, scan_status) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e01', 'plan', repeat('a', 64), 'projects/frt/media/plan-g.webp', 'image/webp', 2400, 980, 300000, 'clean'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e02', 'photo', repeat('b', 64), 'projects/frt/media/pump-room-sim-1.webp', 'image/webp', 4000, 3000, 2400000, 'clean'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e03', 'photo', repeat('c', 64), 'projects/frt/media/pump-room-sim-2.webp', 'image/webp', 4000, 3000, 2500000, 'clean');
INSERT INTO views (project_id, id, kind, title, subject_type, subject_id, file_id, created_by) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e11', 'plan', 'ผังชั้น G', 'floor', 'a0000000-0000-4000-8000-0000000000f0', 'a0000000-0000-4000-8000-000000000e01', '00000000-0000-4000-8000-00000000000a'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e12', 'photo', 'ห้องปั๊ม ชั้น G (ภาพจำลอง)', 'space', 'a0000000-0000-4000-8000-000000000c01', 'a0000000-0000-4000-8000-000000000e02', '00000000-0000-4000-8000-00000000000a');
INSERT INTO placements (project_id, view_id, target_type, point_id, shape, geometry, resolved_file_sha256) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e11', 'point', 'a0000000-0000-4000-8000-000000000b01', 'pin', '{"u":0.88,"v":0.86}', repeat('a', 64)),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e12', 'point', 'a0000000-0000-4000-8000-000000000b01', 'rect', '{"u":0.60,"v":0.55,"w":0.12,"h":0.20}', repeat('b', 64));
RESET app.lifecycle_bypass;

-- ---------------------------------------------------------------- 1) โครงสร้างและการแยกโครงการ (เจ้าของ schema)
DO $$ BEGIN
  PERFORM set_config('app.lifecycle_bypass', 'migration', true); -- ข้ามกติกาสถานะ เพื่อทดสอบ FK อย่างเดียว
  INSERT INTO monitoring_points (project_id, floor_id, code, name, system) VALUES ('22222222-2222-4222-8222-222222222222', 'a0000000-0000-4000-8000-0000000000f0', 'X-1', 'อ้างชั้นของ Fortune', 'water');
  PERFORM t('1 จุดของโครงการ OFC อ้างชั้นของ FRT ไม่ได้ (FK คู่ project_id,id)', false, 'inserted');
EXCEPTION WHEN foreign_key_violation THEN PERFORM t('1 จุดของโครงการ OFC อ้างชั้นของ FRT ไม่ได้ (FK คู่ project_id,id)', true);
          WHEN insufficient_privilege THEN PERFORM t('1 จุดของโครงการ OFC อ้างชั้นของ FRT ไม่ได้ (FK คู่ project_id,id)', false, 'blocked by lifecycle guard before FK'); END $$;

DO $$ BEGIN
  INSERT INTO bindings (project_id, asset_id, point_id, metric_id, role) VALUES ('22222222-2222-4222-8222-222222222222', 'a0000000-0000-4000-8000-000000000a01', 'b0000000-0000-4000-8000-000000000b01', 'level', 'level');
  PERFORM t('2 Binding ข้ามโครงการไม่ได้', false, 'inserted');
EXCEPTION WHEN foreign_key_violation THEN PERFORM t('2 Binding ข้ามโครงการไม่ได้', true); END $$;

SELECT t('3 รหัส WL-001 ซ้ำต่างโครงการได้ (FRT และ OFC เป็นคนละ UUID)', (SELECT count(DISTINCT id) = 2 FROM monitoring_points WHERE code = 'WL-001'));

DO $$ BEGIN
  INSERT INTO placements (project_id, view_id, target_type, point_id, shape, geometry, resolved_file_sha256) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e12', 'point', 'a0000000-0000-4000-8000-000000000b03', 'pin', '{"u":1.3,"v":0.2}', repeat('b', 64));
  PERFORM t('4 Hotspot นอกขอบภาพ (u > 1) ถูกปฏิเสธ', false, 'inserted');
EXCEPTION WHEN check_violation THEN PERFORM t('4 Hotspot นอกขอบภาพ (u > 1) ถูกปฏิเสธ', true); END $$;

DO $$ BEGIN
  INSERT INTO placements (project_id, view_id, target_type, point_id, shape, geometry, resolved_file_sha256) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e12', 'point', 'a0000000-0000-4000-8000-000000000b01', 'pin', '{"u":0.2,"v":0.2}', repeat('b', 64));
  PERFORM t('5 Monitoring Point หนึ่งจุดมีตำแหน่งเดียวต่อมุมมอง (ย้าย ไม่ใช่เพิ่มซ้ำ)', false, 'inserted');
EXCEPTION WHEN unique_violation THEN PERFORM t('5 Monitoring Point หนึ่งจุดมีตำแหน่งเดียวต่อมุมมอง (ย้าย ไม่ใช่เพิ่มซ้ำ)', true); END $$;

SELECT t('6 WL-001 ปรากฏทั้งผัง 2D และรูปห้องปั๊ม ด้วย UUID เดียวกัน (point_appearances)',
  (SELECT count(*) = 2 AND count(DISTINCT view_kind) = 2 FROM point_appearances WHERE point_id = 'a0000000-0000-4000-8000-000000000b01'));

UPDATE views SET file_id = 'a0000000-0000-4000-8000-000000000e03' WHERE id = 'a0000000-0000-4000-8000-000000000e12';
SELECT t('7 เปลี่ยนรูปของมุมมอง → Hotspot เป็น needs_remapping (image-changed) ไม่ถูกลบ · ผัง 2D ไม่กระทบ',
  (SELECT mapping_status = 'needs_remapping' AND remap_reasons = '{image-changed}' FROM placements WHERE view_id = 'a0000000-0000-4000-8000-000000000e12')
  AND (SELECT mapping_status = 'mapped' FROM placements WHERE view_id = 'a0000000-0000-4000-8000-000000000e11'));

DO $$ BEGIN
  INSERT INTO views (project_id, kind, title, subject_type, subject_id, file_id) VALUES ('22222222-2222-4222-8222-222222222222', 'photo', 'รูปของอีกโครงการ', 'space', 'a0000000-0000-4000-8000-000000000c01', 'a0000000-0000-4000-8000-000000000e02');
  PERFORM t('8 มุมมองของโครงการ OFC อ้างพื้นที่/ไฟล์ของ FRT ไม่ได้', false, 'inserted');
EXCEPTION WHEN foreign_key_violation THEN PERFORM t('8 มุมมองของโครงการ OFC อ้างพื้นที่/ไฟล์ของ FRT ไม่ได้', true); END $$;

SELECT t('9 Site เป็นระดับเสริม: FRT (1 Site) ซ่อน · OFC (อาคารไม่มี Site) ซ่อน · CMP (2 Site) แสดง',
  (SELECT array_agg(h.show_site_level ORDER BY p.code) FROM project_hierarchy_settings h JOIN projects p ON p.id = h.project_id) = ARRAY[true, false, false]::boolean[]);  -- CMP, FRT, OFC

-- ---------------------------------------------------------------- 2) เปลี่ยน Device: ประวัติ กราฟ Alarm การรับทราบ ของ Monitoring Point คงอยู่
SET ROLE app_user;
SELECT as_user('00000000-0000-4000-8000-000000000001'); -- Installer
UPDATE device_installations SET removed_at = '2026-10-10 09:00+07', removed_by = app.current_user_id(), note = 'เปลี่ยนเครื่อง' WHERE device_id = 'a0000000-0000-4000-8000-000000000d01' AND removed_at IS NULL;
INSERT INTO device_installations (project_id, device_id, point_id, installed_at, installed_by) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000d02', 'a0000000-0000-4000-8000-000000000b01', '2026-10-10 09:00+07', app.current_user_id());
RESET ROLE;
INSERT INTO telemetry_samples (project_id, point_id, metric_id, observed_at, value_num, device_id) VALUES   -- Ingest Service (role แยก)
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000b01', 'level', '2026-10-10 09:05+07', 62.5, 'a0000000-0000-4000-8000-000000000d02');
SET ROLE app_user;
SELECT as_user('00000000-0000-4000-8000-00000000000a'); -- Technical Editor รับทราบ Alarm ที่เกิดก่อนเปลี่ยนเครื่อง
INSERT INTO alarm_acknowledgements (project_id, episode_id, by_user, note) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-0000000000aa', app.current_user_id(), 'ตรวจหน้างานแล้ว');
SELECT t('10 เปลี่ยน Device GW-01 → GW-02: กราฟของ WL-001 มีค่าจากทั้งสองเครื่องต่อเนื่อง (3 ค่า) · ระบุเครื่องที่ส่งได้',
  (SELECT count(*) = 3 AND count(DISTINCT device_source_key) = 2 FROM point_history WHERE point_id = 'a0000000-0000-4000-8000-000000000b01'));
SELECT t('11 Alarm ที่เกิดก่อนเปลี่ยนเครื่องยังผูกกับจุดเดิม และรับทราบได้หลังเปลี่ยนเครื่อง',
  (SELECT count(*) = 1 FROM alarm_episodes e JOIN alarm_acknowledgements a ON a.episode_id = e.id WHERE e.point_id = 'a0000000-0000-4000-8000-000000000b01'));
DO $$ BEGIN
  INSERT INTO alarm_acknowledgements (project_id, episode_id, by_user) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-00000000000c');
  PERFORM t('12 รับทราบ Alarm ในนามคนอื่นไม่ได้', false, 'inserted');
EXCEPTION WHEN insufficient_privilege THEN PERFORM t('12 รับทราบ Alarm ในนามคนอื่นไม่ได้', true); END $$;
DO $$ BEGIN
  INSERT INTO device_installations (project_id, device_id, point_id, installed_at) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000d01', 'a0000000-0000-4000-8000-000000000b01', '2026-10-11');
  PERFORM t('13 Technical Editor บันทึกการติดตั้ง Device ซ้อนบนจุดที่มีเครื่องอยู่ไม่ได้', false, 'inserted');
EXCEPTION WHEN unique_violation THEN PERFORM t('13 Technical Editor บันทึกการติดตั้ง Device ซ้อนบนจุดที่มีเครื่องอยู่ไม่ได้', true); END $$;

-- ---------------------------------------------------------------- 3) บทบาทและสถานะติดตั้ง (Proposed → Approved → Installed → Commissioned)
SELECT as_user('00000000-0000-4000-8000-00000000000a'); -- Technical Editor
INSERT INTO monitoring_points (project_id, id, floor_id, space_id, code, name, system, install_status)
  VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000b09', 'a0000000-0000-4000-8000-0000000000f0', 'a0000000-0000-4000-8000-000000000c01', 'PG-101', 'น้ำรั่วห้องปั๊ม', 'water', 'proposed');
UPDATE monitoring_points SET install_status = 'pending_approval' WHERE id = 'a0000000-0000-4000-8000-000000000b09';
SELECT t('14 Technical Editor สร้างจุด "เสนอ" และส่ง "รออนุมัติ" ได้', (SELECT install_status = 'pending_approval' FROM monitoring_points WHERE id = 'a0000000-0000-4000-8000-000000000b09'));
DO $$ BEGIN
  UPDATE monitoring_points SET install_status = 'approved' WHERE id = 'a0000000-0000-4000-8000-000000000b09';
  PERFORM t('15 Technical Editor อนุมัติเองไม่ได้', false, 'updated');
EXCEPTION WHEN insufficient_privilege THEN PERFORM t('15 Technical Editor อนุมัติเองไม่ได้', true); END $$;
SELECT as_user('00000000-0000-4000-8000-0000000000a1'); -- AI/บัญชีระบบ (มีบทบาท client_approver)
DO $$ BEGIN
  UPDATE monitoring_points SET install_status = 'approved' WHERE id = 'a0000000-0000-4000-8000-000000000b09';
  PERFORM t('16 AI/บัญชีระบบอนุมัติไม่ได้ แม้ได้บทบาท Client Approver', false, 'updated');
EXCEPTION WHEN insufficient_privilege THEN PERFORM t('16 AI/บัญชีระบบอนุมัติไม่ได้ แม้ได้บทบาท Client Approver', true); END $$;
SELECT as_user('00000000-0000-4000-8000-00000000000c'); -- Client Approver
UPDATE monitoring_points SET install_status = 'approved' WHERE id = 'a0000000-0000-4000-8000-000000000b09';
SELECT t('17 Client Approver อนุมัติได้', (SELECT install_status = 'approved' FROM monitoring_points WHERE id = 'a0000000-0000-4000-8000-000000000b09'));
SELECT as_user('00000000-0000-4000-8000-000000000001'); -- Installer
DO $$ BEGIN
  UPDATE monitoring_points SET install_status = 'installed' WHERE id = 'a0000000-0000-4000-8000-000000000b09';
  PERFORM t('18 Installer ตั้ง "ติดตั้งแล้ว" ไม่ได้ถ้ายังไม่มี Device ที่จุดนั้น', false, 'updated');
EXCEPTION WHEN insufficient_privilege THEN PERFORM t('18 Installer ตั้ง "ติดตั้งแล้ว" ไม่ได้ถ้ายังไม่มี Device ที่จุดนั้น', true); END $$;
INSERT INTO devices (project_id, id, source_key, model) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000d09', 'LK-09', 'Leak sensor');
INSERT INTO device_installations (project_id, device_id, point_id, installed_at, installed_by) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000d09', 'a0000000-0000-4000-8000-000000000b09', now(), app.current_user_id());
UPDATE monitoring_points SET install_status = 'installed' WHERE id = 'a0000000-0000-4000-8000-000000000b09';
SELECT t('19 Installer ติดตั้ง Device แล้วตั้ง "ติดตั้งแล้ว" ได้', (SELECT install_status = 'installed' FROM monitoring_points WHERE id = 'a0000000-0000-4000-8000-000000000b09'));
DO $$ BEGIN
  UPDATE monitoring_points SET install_status = 'commissioned' WHERE id = 'a0000000-0000-4000-8000-000000000b09';
  PERFORM t('20 Installer ส่งมอบใช้งาน (Commission) เองไม่ได้', false, 'updated');
EXCEPTION WHEN insufficient_privilege THEN PERFORM t('20 Installer ส่งมอบใช้งาน (Commission) เองไม่ได้', true); END $$;
SELECT as_user('00000000-0000-4000-8000-0000000000a1');
DO $$ BEGIN
  UPDATE monitoring_points SET install_status = 'commissioned' WHERE id = 'a0000000-0000-4000-8000-000000000b09';
  PERFORM t('21 AI/บัญชีระบบ Commission ไม่ได้ แม้ได้บทบาท Commissioning Engineer', false, 'updated');
EXCEPTION WHEN insufficient_privilege THEN PERFORM t('21 AI/บัญชีระบบ Commission ไม่ได้ แม้ได้บทบาท Commissioning Engineer', true); END $$;
SELECT as_user('00000000-0000-4000-8000-00000000000e'); -- Commissioning Engineer
UPDATE monitoring_points SET install_status = 'commissioned' WHERE id = 'a0000000-0000-4000-8000-000000000b09';
SELECT t('22 Commissioning Engineer ส่งมอบใช้งานได้', (SELECT install_status = 'commissioned' FROM monitoring_points WHERE id = 'a0000000-0000-4000-8000-000000000b09'));
SELECT as_user('00000000-0000-4000-8000-0000000000a1');
DO $$ BEGIN
  UPDATE views SET status = 'published', approved_by = '00000000-0000-4000-8000-0000000000a1' WHERE id = 'a0000000-0000-4000-8000-000000000e12';
  PERFORM t('23 AI/บัญชีระบบอนุมัติ/เผยแพร่รูปไม่ได้', false, 'updated');
EXCEPTION WHEN insufficient_privilege THEN PERFORM t('23 AI/บัญชีระบบอนุมัติ/เผยแพร่รูปไม่ได้', true); END $$;
SELECT as_user('00000000-0000-4000-8000-00000000000c');
UPDATE views SET status = 'approved', approved_by = app.current_user_id() WHERE id = 'a0000000-0000-4000-8000-000000000e12';
SELECT t('24 Client Approver อนุมัติรูปได้ (บันทึกเวลาอนุมัติ)', (SELECT status = 'approved' AND approved_at IS NOT NULL FROM views WHERE id = 'a0000000-0000-4000-8000-000000000e12'));
SELECT as_user('00000000-0000-4000-8000-00000000000d'); -- Client Reviewer
INSERT INTO review_comments (project_id, entity_type, entity_id, author_id, body) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'placement', 'a0000000-0000-4000-8000-000000000e12', app.current_user_id(), 'ตำแหน่งบ่อในรูปเลื่อนไปทางซ้าย');
UPDATE monitoring_points SET name = 'Reviewer แก้ชื่อ' WHERE id = 'a0000000-0000-4000-8000-000000000b01';
SELECT t('25 Client Reviewer แสดงความเห็นได้ แต่แก้ข้อมูลจุดไม่ได้ (0 แถว)',
  (SELECT count(*) = 1 FROM review_comments) AND (SELECT name = 'ระดับน้ำบ่อสูบน้ำ' FROM monitoring_points WHERE id = 'a0000000-0000-4000-8000-000000000b01'));
SELECT as_user('00000000-0000-4000-8000-00000000000f'); -- Viewer
DO $$ BEGIN
  INSERT INTO alarm_acknowledgements (project_id, episode_id, by_user) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-0000000000aa', app.current_user_id());
  PERFORM t('26 Viewer ดูได้อย่างเดียว (รับทราบ Alarm ไม่ได้)', false, 'inserted');
EXCEPTION WHEN insufficient_privilege THEN PERFORM t('26 Viewer ดูได้อย่างเดียว (รับทราบ Alarm ไม่ได้)', (SELECT count(*) > 0 FROM monitoring_points)); END $$;
DO $$ BEGIN
  DELETE FROM monitoring_points WHERE id = 'a0000000-0000-4000-8000-000000000b01';
  PERFORM t('27 ลบจุดไม่ได้ทุกบทบาท (ใช้เก็บถาวร/ปลดระวาง เพื่อรักษาประวัติ)', NOT FOUND);
END $$;
RESET ROLE;
SELECT t('28 ทุกการเปลี่ยนสถานะติดตั้งมี Audit (ผู้ทำ + จาก → ถึง)',
  (SELECT count(*) = 4 AND bool_and(actor_id IS NOT NULL) FROM audit_log WHERE action = 'install_status' AND entity_id = 'a0000000-0000-4000-8000-000000000b09' AND (detail->>'from') IS NOT NULL));

-- ---------------------------------------------------------------- 4) Row-Level Security ข้ามโครงการ
SET ROLE app_user;
SELECT as_user('00000000-0000-4000-8000-00000000000a');
SELECT t('29 RLS: ผู้ใช้ FRT เห็นเฉพาะโครงการ FRT (โครงการ/จุด/รูป/ค่าวัด)',
  (SELECT count(*) = 1 FROM projects) AND (SELECT bool_and(project_id = '9e75d596-b5b8-4e96-a923-f575a1ebc3d5') FROM monitoring_points) AND (SELECT count(*) = 3 FROM media_files) AND (SELECT count(*) = 3 FROM telemetry_samples));
SELECT t('30 RLS: เดา UUID ของจุดโครงการ OFC แล้วอ่านไม่ได้ (IDOR)', (SELECT count(*) = 0 FROM monitoring_points WHERE id = 'b0000000-0000-4000-8000-000000000b01'));
DO $$ BEGIN
  INSERT INTO sites (project_id, code, name) VALUES ('22222222-2222-4222-8222-222222222222', 'HACK', 'เพิ่มในโครงการอื่น');
  PERFORM t('31 RLS: เขียนข้อมูลลงโครงการที่ไม่ได้เป็นสมาชิกไม่ได้', false, 'inserted');
EXCEPTION WHEN insufficient_privilege THEN PERFORM t('31 RLS: เขียนข้อมูลลงโครงการที่ไม่ได้เป็นสมาชิกไม่ได้', true); END $$;
UPDATE monitoring_points SET name = 'แก้ข้ามโครงการ' WHERE id = 'b0000000-0000-4000-8000-000000000b01';
SELECT as_user('');
SELECT t('32 RLS: ไม่มีผู้ใช้ (ไม่ได้ตั้ง session) = ไม่เห็นข้อมูลใด', (SELECT count(*) = 0 FROM monitoring_points) AND (SELECT count(*) = 0 FROM projects) AND (SELECT count(*) = 0 FROM telemetry_samples));
SELECT as_user('00000000-0000-4000-8000-00000000000b');
SELECT t('33 RLS: ผู้ใช้ OFC ไม่เห็นรูป/ค่าวัด/Alarm ของ Fortune', (SELECT count(*) = 0 FROM media_files) AND (SELECT count(*) = 0 FROM telemetry_samples) AND (SELECT count(*) = 0 FROM alarm_episodes) AND (SELECT count(*) = 1 FROM monitoring_points));
RESET ROLE;
SELECT t('34 RLS: UPDATE ข้ามโครงการไม่มีผล (0 แถว)', (SELECT name = 'รหัสเดียวกันแต่คนละโครงการ' FROM monitoring_points WHERE id = 'b0000000-0000-4000-8000-000000000b01'));

\echo
SELECT n AS "#", CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, name, detail FROM test_results ORDER BY n;
SELECT count(*) FILTER (WHERE ok) || '/' || count(*) AS passed FROM test_results;
