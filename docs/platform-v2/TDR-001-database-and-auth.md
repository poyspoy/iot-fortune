# TDR-001 — ฐานข้อมูลและการยืนยันตัวตนของ Pilot (สถานะ: เสนอ · รอตัดสิน)

> Technical Decision Record · 20 ต.ค. 2569 · ขอบเขต: Fortune Pilot ของ Floor Plan Platform (โมดูล 5: Backend/API, Authentication, Role, Project Isolation)
> ราคาและความสามารถของผู้ให้บริการตรวจจากเอกสารสาธารณะ ณ วันที่เขียน — **ต้องยืนยันกับใบเสนอราคา/เอกสารปัจจุบันอีกครั้งก่อนตัดสิน**

## 1. โจทย์

- Schema ที่ออกแบบแล้ว (`db/hierarchy_photo.sql`) ต้องการ **PostgreSQL 15+** พร้อม Row-Level Security, trigger, `security_invoker` view — ทดสอบผ่าน 34/34 บน PostgreSQL 16
- ผู้ใช้เป็นพนักงานองค์กรและลูกค้า → ต้องการ SSO กับ **Microsoft Entra ID** (เดิมชื่อ Azure AD)
- ต้องการ: แยกโครงการระดับฐานข้อมูล, Audit, สำรอง/กู้คืน, เก็บไฟล์รูปแบบ private, ภาระดูแลระบบต่ำสำหรับทีมเล็ก, ข้อมูลส่วนบุคคลตาม PDPA

## 2. ทางเลือก

### A) Supabase (Managed PostgreSQL) + Microsoft Entra ID

| เรื่อง | รายละเอียด |
|---|---|
| ฐานข้อมูล | PostgreSQL จัดการให้ · ใช้ schema/RLS ชุดนี้ได้ตรง ๆ (RLS เป็นกลไกหลักของ Supabase) |
| Login Entra ID | 2 ทาง: (1) **OAuth provider "Azure"** — จำกัดเฉพาะ tenant ขององค์กรได้ด้วย Azure Tenant URL `https://login.microsoftonline.com/<tenant-id>` · ต้องขอ scope `email` · ควรเพิ่ม claim `xms_edov` เพื่อยืนยันว่าอีเมลผ่านการตรวจ (ป้องกันการแอบอ้างอีเมลที่ยังไม่ยืนยัน) · client secret หมดอายุ ต้องต่ออายุตามรอบ (2) **SAML 2.0 SSO** — มีในแพ็กเกจ Pro ขึ้นไป รองรับ Entra (ใช้ metadata URL ได้) |
| ข้อจำกัด SAML ที่เกี่ยวข้อง | ไม่รองรับ Single Logout (ใช้ session timeout แทน) · บัญชี SSO ไม่ผูกกับบัญชีอีเมลเดียวกันที่มีอยู่ (อีเมลซ้ำได้ — ต้องอ้างผู้ใช้ด้วย UUID ซึ่ง schema ทำอยู่แล้ว) · IdP-initiated flow ใช้กับ PKCE ไม่ได้ |
| การเชื่อมกับ schema | Supabase ให้ `auth.uid()` ใน DB → เปลี่ยน `app.current_user_id()` ให้อ่านจาก JWT ได้ · หรือ API ของเราเองตั้ง `app.user_id` ตามเดิม (แนะนำ: API ของเราตรวจ membership + ตั้งค่า, ไม่เปิด PostgREST ตรงสู่ Frontend ในรอบแรก) |
| ไฟล์ | Supabase Storage (bucket private + signed URL) หรือใช้ Cloudflare R2 ตามแผนเดิม |
| สำรอง | daily backup ตามแพ็กเกจ · Point-in-Time Recovery เป็นส่วนเสริม (มีค่าใช้จ่ายเพิ่ม) |
| ภูมิภาค | เลือกภูมิภาคเอเชียตะวันออกเฉียงใต้ได้ (ตรวจรายชื่อภูมิภาคปัจจุบันก่อนสร้างโครงการ) — ข้อมูลอยู่นอกประเทศไทย ต้องประเมินตาม PDPA (การส่งข้อมูลไปต่างประเทศ) |
| ค่าใช้จ่าย (โดยประมาณ จากบทความที่ตรวจ ก.ย. 2569) | Pro ≈ US$25/เดือน (รวมเครดิต compute ขนาดเล็ก, DB 8 GB, 100,000 MAU) · PITR ≈ US$100/เดือนต่อการเก็บ 7 วัน · SSO MAU เกินโควตา ≈ US$0.015/คน · ต้องยืนยันราคาจริง |
| ภาระทีม | ต่ำ: ไม่ต้องดูแลเครื่อง/แพตช์/สำรองเอง |
| ความเสี่ยง | ผูกกับผู้ให้บริการ (ลดได้เพราะใช้ PostgreSQL มาตรฐาน + migration SQL ของเราเอง) · ข้อจำกัด compute ของแพ็กเกจเล็ก · ต้องตั้งค่าความปลอดภัยให้ถูก (ไม่เปิด anon key ให้เขียนตรง) |

### B) PostgreSQL ของเราเอง (Self-managed) + Entra ID ผ่าน OIDC ที่ API

| เรื่อง | รายละเอียด |
|---|---|
| ฐานข้อมูล | PostgreSQL 16 บน VM/Container ของเรา (หรือ Managed PG ของ Cloud เช่น Azure Database for PostgreSQL) · schema ชุดนี้ใช้ได้ตรง |
| Login Entra ID | API ทำ OIDC กับ Entra เอง (ไลบรารีมาตรฐาน) · จำกัด tenant · ตรวจ `tid`/`oid` · ออก session cookie แบบ HttpOnly |
| ไฟล์ | Cloudflare R2 / S3 (private + pre-signed URL) |
| สำรอง | ต้องตั้งเอง: base backup + WAL archive (PITR) + ทดสอบกู้คืนรายเดือน |
| ภูมิภาค | เลือกได้อิสระ รวมถึงในประเทศไทย (ถ้า PDPA/สัญญาลูกค้ากำหนด) |
| ค่าใช้จ่าย | ค่าเครื่องอาจต่ำกว่า แต่ **ค่าแรงดูแล** (แพตช์ความปลอดภัย, monitoring, backup, failover, on-call) สูงกว่ามาก |
| ภาระทีม | สูง: ต้องมีผู้รับผิดชอบระบบฐานข้อมูลและความปลอดภัยต่อเนื่อง |
| ความเสี่ยง | ความผิดพลาดด้านการตั้งค่า/สำรอง/แพตช์อยู่ที่ทีมเราทั้งหมด |

## 3. เปรียบเทียบตามเกณฑ์

| เกณฑ์ (น้ำหนัก) | A Supabase + Entra | B PostgreSQL ของเรา + Entra |
|---|---|---|
| ความปลอดภัย/แยกโครงการ (สูง) | RLS + FK คู่ ชุดเดียวกัน · Auth จัดการให้ | RLS + FK คู่ ชุดเดียวกัน · Auth ต้องเขียน/ดูแลเอง |
| เวลาถึง Pilot (สูง) | เร็ว (วัน–สัปดาห์) | ช้ากว่า (ต้องตั้งโครงสร้างพื้นฐาน) |
| ภาระดูแลระยะยาว (สูง) | ต่ำ | สูง |
| PDPA / ที่ตั้งข้อมูล (สูง) | ต่างประเทศ (ภูมิภาคใกล้เคียง) — ต้องประเมิน/ทำสัญญา | เลือกในประเทศได้ |
| ค่าใช้จ่ายรวม (กลาง) | คาดเดาได้ ค่าแรงต่ำ | ค่าเครื่องต่ำ ค่าแรงสูง |
| ย้ายออกภายหลัง (กลาง) | ได้ (PostgreSQL มาตรฐาน + pg_dump) — Auth ต้องย้ายผู้ใช้ | ไม่มีปัญหา |
| Entra SSO | มีทั้ง OAuth และ SAML (Pro+) | OIDC มาตรฐานที่ API |

## 4. ข้อเสนอ

**Pilot ใช้ทางเลือก A (Supabase + Entra ID ผ่าน OAuth provider จำกัด tenant) โดยมีเงื่อนไข:**

1. Frontend **ไม่** คุยกับ Supabase ตรงเพื่อเขียนข้อมูล — ผ่าน API ของเรา (ตรวจ membership + ตั้ง `app.user_id`) · service key อยู่ฝั่ง Server เท่านั้น · anon key ไม่มีสิทธิ์ตารางใด
2. RLS + FK คู่ + trigger ชุดเดียวกับที่ทดสอบ 34/34 · เพิ่มชุดทดสอบ IDOR/BOLA อัตโนมัติบน Supabase จริงก่อนเปิดใช้
3. รูปของลูกค้าจริงขึ้นได้หลังผ่าน Security Review เท่านั้น (ก่อนหน้านั้นใช้ภาพจำลอง/ลบข้อมูลสำคัญแล้ว)
4. ทำ DPIA (การประเมินผลกระทบข้อมูลส่วนบุคคล) และตรวจข้อกำหนดการส่งข้อมูลไปต่างประเทศตาม PDPA ก่อน Production — **ถ้าลูกค้า/สัญญากำหนดให้ข้อมูลอยู่ในประเทศ ให้เปลี่ยนเป็นทางเลือก B** (schema/API เดียวกัน ย้ายได้)
5. เก็บ migration SQL ใน Git ของเรา (ไม่สร้างตารางผ่านหน้า Dashboard) เพื่อย้ายผู้ให้บริการได้

## 5. สิ่งที่ต้องยืนยันก่อนตัดสิน

- ราคา/โควตาปัจจุบันของ Supabase (แพ็กเกจ, PITR, SSO) และภูมิภาคที่ใช้ได้
- Tenant Entra ID ที่ใช้ (องค์กรเรา + ลูกค้าแยก tenant หรือไม่ → ถ้าลูกค้าใช้ tenant ของตัวเอง อาจต้อง SAML ต่อ tenant หรือ B2B guest)
- ข้อกำหนด PDPA/สัญญาลูกค้าเรื่องที่ตั้งข้อมูล
- ผู้รับผิดชอบดูแลระบบ (กรณีเลือก B)

## แหล่งอ้างอิง

- Supabase — Login with Azure (Microsoft): https://supabase.com/docs/guides/auth/auth-azure
- Supabase — Single Sign-On with SAML 2.0 for Projects: https://supabase.com/docs/guides/auth/sso/auth-sso-saml
- ราคา (บทความรวบรวม ตรวจ ก.ย. 2569 — ต้องยืนยันกับหน้าราคาทางการ): https://makerkit.dev/blog/saas/supabase-pricing
