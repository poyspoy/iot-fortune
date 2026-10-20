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

-- ---------------------------------------------------------------- ข้อมูลทดสอบ (เจ้าของ schema — ไม่ผ่าน RLS)
INSERT INTO users (id, email, display_name, kind) VALUES
  ('00000000-0000-4000-8000-00000000000a', 'a@example.com', 'ผู้ใช้ A (Fortune)', 'human'),
  ('00000000-0000-4000-8000-00000000000b', 'b@example.com', 'ผู้ใช้ B (โครงการอื่น)', 'human'),
  ('00000000-0000-4000-8000-0000000000a1', null, 'Import Worker', 'service');
INSERT INTO organizations (id, code, name) VALUES
  ('07fda8e7-e183-4174-9d18-9f16bcd92656', 'FRT-ORG', 'Fortune Demo Organization'),
  ('11111111-1111-4111-8111-111111111111', 'OTHER', 'องค์กรอื่น');
INSERT INTO projects (id, organization_id, code, name, settings) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', '07fda8e7-e183-4174-9d18-9f16bcd92656', 'FRT', 'IoT ฟอร์จูน (Pilot)', '{"defaultPointInstallStatus":"installed"}'),
  ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'OFC', 'สำนักงานตัวอย่าง', '{}');
INSERT INTO project_members VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', '00000000-0000-4000-8000-00000000000a', 'admin'),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-00000000000b', 'admin');
INSERT INTO asset_types (id, name) VALUES ('pump', 'ปั๊ม'), ('pit', 'บ่อ'), ('tank', 'ถัง');
INSERT INTO sites (project_id, id, code, name) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000001', 'FORTUNE-TOWN', 'ฟอร์จูนทาวน์'),
  ('22222222-2222-4222-8222-222222222222', 'b0000000-0000-4000-8000-000000000001', 'HQ', 'สำนักงานใหญ่');
INSERT INTO buildings (project_id, id, site_id, code, name) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'c9189748-40c5-4bc9-bd62-c618508e9061', 'a0000000-0000-4000-8000-000000000001', 'FORTUNE-TOWN', 'ฟอร์จูนทาวน์'),
  ('22222222-2222-4222-8222-222222222222', 'b0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'HQ-A', 'อาคาร A');
INSERT INTO floors (project_id, id, building_id, code, name, sort_order, elevation, height, plan_transform) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-0000000000f0', 'c9189748-40c5-4bc9-bd62-c618508e9061', 'G', 'ชั้น G', 0, 0, 0.6, '{12,0,-6,0,4.9,-2.45}'),
  ('22222222-2222-4222-8222-222222222222', 'b0000000-0000-4000-8000-0000000000f0', 'b0000000-0000-4000-8000-000000000002', '1', 'ชั้น 1', 1, 0, 3, '{20,0,-10,0,10,-5}');
INSERT INTO spaces (project_id, id, floor_id, code, name, kind) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000c01', 'a0000000-0000-4000-8000-0000000000f0', 'G-SVC', 'พื้นที่บริการ ชั้น G', 'service');
INSERT INTO assets (project_id, id, floor_id, space_id, type_id, code, name, is_demo, install_status, visual) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000a01', 'a0000000-0000-4000-8000-0000000000f0', 'a0000000-0000-4000-8000-000000000c01', 'pump', 'FRT-DEMO-PUMP-001', 'ปั๊มน้ำ (สาธิต)', true, 'installed', '{"kind":"pump","offset":{"x":-0.6,"z":0}}'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000a02', 'a0000000-0000-4000-8000-0000000000f0', 'a0000000-0000-4000-8000-000000000c01', 'pit', 'FRT-DEMO-PIT-001', 'บ่อสูบน้ำ (สาธิต)', true, 'installed', '{"kind":"pit","offset":{"x":0.42,"z":0}}');
INSERT INTO points (project_id, id, floor_id, space_id, code, name, system, is_demo, install_status) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000b01', 'a0000000-0000-4000-8000-0000000000f0', 'a0000000-0000-4000-8000-000000000c01', 'WL-001', 'ระดับน้ำบ่อสูบน้ำ', 'water', true, 'installed'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000b03', 'a0000000-0000-4000-8000-0000000000f0', 'a0000000-0000-4000-8000-000000000c01', 'P-003', 'ปั๊มน้ำ (ตัวอย่าง)', 'water', true, 'installed'),
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
INSERT INTO media_files (project_id, id, kind, sha256, storage_key, content_type, width_px, height_px, bytes, scan_status) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e01', 'plan', repeat('a', 64), 'projects/frt/media/plan-g.webp', 'image/webp', 2400, 980, 300000, 'clean'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e02', 'photo', repeat('b', 64), 'projects/frt/media/pump-room-1.webp', 'image/webp', 4000, 3000, 2400000, 'clean'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e03', 'photo', repeat('c', 64), 'projects/frt/media/pump-room-2.webp', 'image/webp', 4000, 3000, 2500000, 'clean');
INSERT INTO views (project_id, id, kind, title, subject_type, subject_id, file_id, created_by) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e11', 'plan', 'ผังชั้น G', 'floor', 'a0000000-0000-4000-8000-0000000000f0', 'a0000000-0000-4000-8000-000000000e01', '00000000-0000-4000-8000-00000000000a'),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e12', 'photo', 'ห้องปั๊ม ชั้น G', 'space', 'a0000000-0000-4000-8000-000000000c01', 'a0000000-0000-4000-8000-000000000e02', '00000000-0000-4000-8000-00000000000a');
INSERT INTO placements (project_id, view_id, target_type, point_id, shape, geometry, resolved_file_sha256) VALUES
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e11', 'point', 'a0000000-0000-4000-8000-000000000b01', 'pin', '{"u":0.88,"v":0.86}', repeat('a', 64)),
  ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e12', 'point', 'a0000000-0000-4000-8000-000000000b01', 'rect', '{"u":0.60,"v":0.55,"w":0.12,"h":0.20}', repeat('b', 64));

-- ---------------------------------------------------------------- 1) ความถูกต้องของโครงสร้าง (เจ้าของ schema)
DO $$ BEGIN
  INSERT INTO points (project_id, floor_id, code, name, system) VALUES ('22222222-2222-4222-8222-222222222222', 'a0000000-0000-4000-8000-0000000000f0', 'X-1', 'อ้างชั้นของ Fortune', 'water');
  PERFORM t('1 จุดของโครงการ OFC อ้างชั้นของ FRT ไม่ได้ (FK คู่ project_id,id)', false, 'inserted');
EXCEPTION WHEN foreign_key_violation THEN PERFORM t('1 จุดของโครงการ OFC อ้างชั้นของ FRT ไม่ได้ (FK คู่ project_id,id)', true); END $$;

DO $$ BEGIN
  INSERT INTO bindings (project_id, asset_id, point_id, metric_id, role) VALUES ('22222222-2222-4222-8222-222222222222', 'a0000000-0000-4000-8000-000000000a01', 'b0000000-0000-4000-8000-000000000b01', 'level', 'level');
  PERFORM t('2 Binding ข้ามโครงการไม่ได้', false, 'inserted');
EXCEPTION WHEN foreign_key_violation THEN PERFORM t('2 Binding ข้ามโครงการไม่ได้', true); END $$;

DO $$ BEGIN
  INSERT INTO points (project_id, floor_id, code, name, system) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-0000000000f0', 'WL-001', 'รหัสซ้ำในโครงการเดียวกัน', 'water');
  PERFORM t('3 รหัสจุดซ้ำในโครงการเดียวกันไม่ได้ · ซ้ำต่างโครงการได้ (WL-001 มีทั้ง FRT และ OFC)', false, 'inserted');
EXCEPTION WHEN unique_violation THEN PERFORM t('3 รหัสจุดซ้ำในโครงการเดียวกันไม่ได้ · ซ้ำต่างโครงการได้ (WL-001 มีทั้ง FRT และ OFC)', (SELECT count(*) = 2 FROM points WHERE code = 'WL-001')); END $$;

DO $$ BEGIN
  INSERT INTO placements (project_id, view_id, target_type, point_id, shape, geometry, resolved_file_sha256) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e12', 'point', 'a0000000-0000-4000-8000-000000000b03', 'pin', '{"u":1.3,"v":0.2}', repeat('b', 64));
  PERFORM t('4 Hotspot นอกขอบภาพ (u > 1) ถูกปฏิเสธ', false, 'inserted');
EXCEPTION WHEN check_violation THEN PERFORM t('4 Hotspot นอกขอบภาพ (u > 1) ถูกปฏิเสธ', true); END $$;

DO $$ BEGIN
  INSERT INTO placements (project_id, view_id, target_type, point_id, shape, geometry, resolved_file_sha256) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000e12', 'point', 'a0000000-0000-4000-8000-000000000b01', 'pin', '{"u":0.2,"v":0.2}', repeat('b', 64));
  PERFORM t('5 จุดเดียวมีตำแหน่งเดียวต่อมุมมอง (ย้าย ไม่ใช่เพิ่มซ้ำ)', false, 'inserted');
EXCEPTION WHEN unique_violation THEN PERFORM t('5 จุดเดียวมีตำแหน่งเดียวต่อมุมมอง (ย้าย ไม่ใช่เพิ่มซ้ำ)', true); END $$;

SELECT t('6 จุด WL-001 ปรากฏทั้งผัง 2D และรูปห้องปั๊ม ด้วย UUID เดียวกัน (point_appearances)',
  (SELECT count(*) = 2 AND count(DISTINCT view_kind) = 2 FROM point_appearances WHERE point_id = 'a0000000-0000-4000-8000-000000000b01'));

UPDATE views SET file_id = 'a0000000-0000-4000-8000-000000000e03' WHERE id = 'a0000000-0000-4000-8000-000000000e12';
SELECT t('7 เปลี่ยนรูปของมุมมอง → Hotspot เป็น needs_remapping (image-changed) ไม่ถูกลบ · ผัง 2D ไม่กระทบ',
  (SELECT mapping_status = 'needs_remapping' AND remap_reasons = '{image-changed}' FROM placements WHERE view_id = 'a0000000-0000-4000-8000-000000000e12')
  AND (SELECT mapping_status = 'mapped' FROM placements WHERE view_id = 'a0000000-0000-4000-8000-000000000e11'));

DO $$ BEGIN
  UPDATE views SET status = 'published', approved_by = '00000000-0000-4000-8000-0000000000a1' WHERE id = 'a0000000-0000-4000-8000-000000000e12';
  PERFORM t('8 บัญชีบริการ (AI/Worker) อนุมัติ/เผยแพร่มุมมองไม่ได้', false, 'updated');
EXCEPTION WHEN insufficient_privilege THEN PERFORM t('8 บัญชีบริการ (AI/Worker) อนุมัติ/เผยแพร่มุมมองไม่ได้', true); END $$;

DO $$ BEGIN
  INSERT INTO device_installations (project_id, device_id, point_id, installed_at) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000d02', 'a0000000-0000-4000-8000-000000000b01', '2026-10-10');
  PERFORM t('9 จุดหนึ่งมีอุปกรณ์ที่ใช้งานได้ทีละตัว', false, 'inserted');
EXCEPTION WHEN unique_violation THEN PERFORM t('9 จุดหนึ่งมีอุปกรณ์ที่ใช้งานได้ทีละตัว', true); END $$;

UPDATE device_installations SET removed_at = '2026-10-10' WHERE device_id = 'a0000000-0000-4000-8000-000000000d01';
INSERT INTO device_installations (project_id, device_id, point_id, installed_at) VALUES ('9e75d596-b5b8-4e96-a923-f575a1ebc3d5', 'a0000000-0000-4000-8000-000000000d02', 'a0000000-0000-4000-8000-000000000b01', '2026-10-10');
SELECT t('10 เปลี่ยนเครื่องเซนเซอร์: ปิดแถวเดิมแล้วติดเครื่องใหม่ที่จุดเดิม (UUID จุดไม่เปลี่ยน ประวัติเป็นของจุด)',
  (SELECT count(*) = 2 FROM device_installations WHERE point_id = 'a0000000-0000-4000-8000-000000000b01'));

DO $$ BEGIN
  INSERT INTO views (project_id, kind, title, subject_type, subject_id, file_id) VALUES ('22222222-2222-4222-8222-222222222222', 'photo', 'รูปของอีกโครงการ', 'space', 'a0000000-0000-4000-8000-000000000c01', 'a0000000-0000-4000-8000-000000000e02');
  PERFORM t('11 มุมมองของโครงการ OFC อ้างพื้นที่/ไฟล์ของ FRT ไม่ได้', false, 'inserted');
EXCEPTION WHEN foreign_key_violation THEN PERFORM t('11 มุมมองของโครงการ OFC อ้างพื้นที่/ไฟล์ของ FRT ไม่ได้', true); END $$;

-- ---------------------------------------------------------------- 2) Row-Level Security (ทำงานเป็น app_user)
SET ROLE app_user;
SET app.user_id = '00000000-0000-4000-8000-00000000000a';
SELECT t('12 RLS: ผู้ใช้ A เห็นเฉพาะโครงการ FRT (โครงการ/จุด/รูป)',
  (SELECT count(*) = 1 FROM projects) AND (SELECT bool_and(project_id = '9e75d596-b5b8-4e96-a923-f575a1ebc3d5') FROM points) AND (SELECT count(*) = 3 FROM media_files));
SELECT t('13 RLS: ผู้ใช้ A เดา UUID ของจุดโครงการ OFC แล้วอ่านไม่ได้ (IDOR)',
  (SELECT count(*) = 0 FROM points WHERE id = 'b0000000-0000-4000-8000-000000000b01'));
DO $$ BEGIN
  INSERT INTO sites (project_id, code, name) VALUES ('22222222-2222-4222-8222-222222222222', 'HACK', 'เพิ่มในโครงการอื่น');
  PERFORM t('14 RLS: ผู้ใช้ A เขียนข้อมูลลงโครงการ OFC ไม่ได้', false, 'inserted');
EXCEPTION WHEN insufficient_privilege THEN PERFORM t('14 RLS: ผู้ใช้ A เขียนข้อมูลลงโครงการ OFC ไม่ได้', true); END $$;
UPDATE points SET name = 'แก้ข้ามโครงการ' WHERE id = 'b0000000-0000-4000-8000-000000000b01';
RESET ROLE;
SELECT t('15 RLS: UPDATE ข้ามโครงการไม่มีผล (0 แถว)', (SELECT name = 'รหัสเดียวกันแต่คนละโครงการ' FROM points WHERE id = 'b0000000-0000-4000-8000-000000000b01'));
SET ROLE app_user;
SET app.user_id = '';
SELECT t('16 RLS: ไม่มีผู้ใช้ (ไม่ได้ตั้ง session) = ไม่เห็นข้อมูลใด', (SELECT count(*) = 0 FROM points) AND (SELECT count(*) = 0 FROM projects));
SET app.user_id = '00000000-0000-4000-8000-00000000000b';
SELECT t('17 RLS: ผู้ใช้ B เห็นเฉพาะ OFC — ไม่เห็นรูปห้องปั๊มของ Fortune', (SELECT count(*) = 0 FROM media_files) AND (SELECT count(*) = 1 FROM points));
RESET ROLE;

\echo
SELECT n AS "#", CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, name, detail FROM test_results ORDER BY n;
SELECT count(*) FILTER (WHERE ok) || '/' || count(*) AS passed FROM test_results;
