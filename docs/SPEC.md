# Solar Metering Application Automation: Build Spec for Claude Code

> **Read this whole file before writing anything.** It is the single source of truth for this build. When something here conflicts with an assumption you have, this file wins. When something here is marked `[CONFIRM]`, stop and ask Rodrigo before building that part.

---

## 0. TL;DR

Build an n8n automation that, when a HubSpot deal in the **Post Sale To Completion** pipeline reaches the stage **"Metering forms need to be submitted"**, works out the customer's electricity retailer and lodges the solar metering application with that retailer through the right channel:

- **Email retailers** (EnergyAustralia, AGL fallback, GloBird, Amber, 1st Energy): build the document pack, get signatures where needed via DocuSeal, send the email, log everything.
- **Portal retailers** (Origin): generate a data sheet and create a HubSpot task for a human to paste into Origin Connect.
- **Phone / unconfirmed retailers** (Red Energy, Powershop, ENGIE, Alinta, Momentum, long tail): create a HubSpot task with the full data pack attached.

Then track every application to completion (chase at day 10, escalate at day 20, close when the metering provider confirms).

**Build order:** Phase 0 (HubSpot prep) → Phase 1 (EnergyAustralia end to end) → Phase 2 (AGL, GloBird, Amber) → Phase 3 (manual-route tasks) → Phase 4 (tracking and chasers).

---

## 1. Business context

- Company: **Impressive Batteries PTY LTD**, working with **Impressive Electrical & Solar** (IES). Solar and battery installs across Sydney, the Sutherland Shire and regional NSW.
- After a first-time PV install in NSW, the customer's meter must be reconfigured (smart meter) or exchanged (basic meter) before the system can export. Only the **retailer** can order this. The retailer sends a service order to its Metering Coordinator (e.g. Intellihub, Plus ES).
- Today the team does this manually. Stage `1509971393` ("Install Complete and metering forms submitted…") holds 266 deals, so volume is real.
- Scope is **NSW only** (Ausgrid, Endeavour, Essential). Evoenergy (ACT) has 2 deals; treat as manual.

### The NSW flow (for your mental model)

1. **Network approval** before install. The installer applies to the distributor. The distributor issues:
   - Ausgrid → **Contract Notification Letter**
   - Endeavour → **Connection of Generator Letter** (a.k.a. Permission to Connect / PTC)
   - Essential → **Connection Service Offer Letter**
2. **Install + CCEW.** The tester lodges the CCEW with Building Commission NSW within 7 days.
3. **Retailer request** ← *this automation*.
4. Retailer → Metering Coordinator service order (remote reconfig or exchange). 10–20 business days typical.
5. Completion → customer switches export on; DER Register record updated.

---

## 2. Environment

| Thing | Value |
|---|---|
| n8n | Self-hosted, `https://n8n.nuevaenergy.com.au`, Docker Compose at `/opt/n8n-docker-caddy/docker-compose.yml` (n8n + Caddy). Custom image already has **poppler** installed. |
| n8n backups | `/root/n8n-backups/` (existing dated folders). **Back up `docker-compose.yml` and export any workflow you modify before changing it.** |
| HubSpot | Portal ID **441838848**, region **ap1** (API base `https://api.hubapi.com` works; UI links use `app-ap1.hubspot.com`). Use the existing HubSpot credential in n8n. |
| DocuSeal | Self-hosted at `https://docuseal.impressivebatteries.com.au` (DigitalOcean, Traefik + Let's Encrypt, Resend for email). Use its API for signature requests. |
| Email | Google Workspace via n8n Gmail node. **Sending mailbox: `[CONFIRM]`** (e.g. metering@ or admin@ an IES/Impressive domain). |
| AI | Anthropic node already used in n8n (PTC workflow uses "Analyze document"). |

### Existing workflows you must know about (do not break them)

- **PTC Approval DER workflow**: Gmail trigger on labelled emails → downloads attachments → IF on subject → Anthropic "Analyze document" extracts **NMI** and **AEMO DER Register job number** from the PDF whose filename contains `_PTC_`. **This is where network approval letters already arrive.** **Do not modify it.** MTR runs its own parallel workflow on the same emails (see §5.3); the original is switched off later if and when MTR fully replaces it.
- **Intellihub "ORDER COMPLETED" parser**: parses Airtable-sent Intellihub emails for meter exchange/reconfiguration completion and extracts the NMI from the HTML body. **Do not modify it.** Phase 4 uses a separate MTR workflow watching the same emails (see §6.0); the original is switched off later if needed.
- **CCEW automation** (`ccew-form-v1.vercel.app`) and **PDF-to-PNG for CCEW uploads**. The CCEW PDF source is here. `[CONFIRM]` where the final CCEW PDF lives (HubSpot file on the deal? Drive? GreenDeal?).
- OpenSolar → HubSpot webhook at `/webhook/other-component-update`. Irrelevant here, but don't reuse that path.

### Working rules for you (Claude Code)

1. Never hard-code secrets. Use n8n credentials. If a credential is missing, stop and say which one.
2. Build every workflow with a **`DRY_RUN` switch** (see §9). Dry run sends all outbound emails to an internal test address and writes nothing to HubSpot except a note prefixed `[DRY RUN]`.
3. Export each finished workflow as JSON into `./workflows/` in this repo with a clear name, and commit.
4. Name workflows with the prefix `MTR –` (e.g. `MTR – 01 Trigger & Router`).
5. Before changing any HubSpot property schema, list the exact change and wait for approval.

---

## 3. HubSpot mapping (verified 23 Sep 2026)

### 3.1 Pipeline and stages

Pipeline **Post Sale To Completion** = `978394588`.

| Purpose | Stage ID | Label |
|---|---|---|
| **Trigger** | `1879662022` | Metering forms need to be submitted (new metering required for first-time PV…) |
| **Move to after lodging** | `1509971393` | Install Complete and metering forms submitted for first time PV installations (waiting for STC…) |
| Later | `1779689928` | STC has been lodged and customer has paid all invoices in full (waiting for DER register…) |
| Later | `1509971394` | Metering forms submitted, DER complete & User Manual has been sent |
| Closed | `1509971395` | Job Closed – Customer has confirmed that metering has been completed / Paid… |
| Ignore | `1509971396` | Job Cancelled |
| Upstream (context) | `2114714048` Job Done – PTC Pending · `1509971392` 95% Complete · `3301252579` Pending Sun Cover – Job Done · `1509971391` Battery Installed | |

> Only move the deal from `1879662022` to `1509971393` **after** the application is actually sent (email route) or the manual task is marked complete (portal/phone route). (Decided: the automation moves the stage.)

### 3.2 Existing deal properties to READ

| Internal name | Type | Use | Notes |
|---|---|---|---|
| `nmi` | string | NMI on every application | Well populated (~396 deals in pipeline). Validate: 10 or 11 chars, alphanumeric. NSW NMIs usually start `4…` or `NCCC…`. |
| `electricity__retailer` | **string (free text)** | Retailer routing | **Double underscore.** Messy: "origin", "origin energy", "origin ", "tbd", "aus grid", etc. Normalise via §4.1. |
| `electricity_distributor` | enum | Pick the network letter and routing | Options: `Ausgrid`, `Endeavour`, `Essential`, `Evoenergy`. 189 deals blank. |
| `phases` | enum | AGL alteration field, EA form | `Single Phase`, `2 Phase`, `3 Phase`, `Controlled Load Meter` (note: CL is mixed into this field; if value is CL, phases is unknown → flag). |
| `type_of_metering_required` | enum | Meter type | `Single Phase Smart Meter`, `Three Phase Smart Meter`, `Single Phase Solar Meter`, `Three Phase Solar Meter` |
| `existing_smart_meter` | enum | Reconfigure vs exchange | `No`, `Yes - Non Intellihub Smart Meter`, `Yes - Intellihub/Acumen Smart Meter` |
| `installation_type` | enum | Skip battery-only jobs | `Solar Only`, `Battery Only`, `Solar & Battery`. **Battery Only with existing solar → metering usually not required → skip with note.** |
| `installation_date` | date | Panel install date (AGL exchange field) | |
| `installation_completion_date` | date | Proxy for inverter switch-on date | `[CONFIRM]` acceptable proxy. |
| `installer` | enum | Which electrical contractor's details go on the form | `Impressive,` (**note trailing comma in the internal value**) and `Energy Flow`. |
| `ptc_status` | enum | Gate: must be `Received No Issues` | Others: `Half Completed-Waiting On Info`, `Submitted`, `Rejected Need Actioning` |
| `ccew_status` | enum | Gate: must be `Lodged` | Others: `Ready to Send`, `Form Sent`, `Error`, `Validation Failed` |
| `ccew_receipt_number` | string | CCEW reference on forms | |
| `ccew_submission_date` | date | Evidence date | |
| `der_register_number` | string | Nice-to-have on forms | Populated by the PTC workflow. |
| `metering_status` | enum | **Write** status here | See §3.4 |
| `hubspot_owner_id` | owner | Task assignee fallback | |
| `dealname`, `hs_object_id` | | Logging | |

**Contact (associated, primary)** for account holder: `firstname`, `lastname`, `email`, `phone`/`mobilephone`, `address`, `city`, `zip`, `state`. `[CONFIRM]` the associated primary contact is always the electricity account holder; if not, see new property `account_holder_name`.

### 3.3 Properties to IGNORE (traps)

- `electricity_retailer` (single underscore): **label is "Is isolator fuse at meter point?"**. It is NOT the retailer. Never read or write it.
- `sf_electricity_distributor`: label "Electricity Distributor" but its options are **retailer names** (Origin Energy, EnergyAustralia, Momentum, Electricity in a Box, Indigo Power…). OpenSolar-synced, and its counts don't match `electricity__retailer` at all (e.g. Momentum 76 vs 5). Treat as unreliable. Do not use for routing. Log it alongside for debugging only.
- `sf_phases`: OpenSolar duplicate of `phases`. Prefer `phases`; fall back to `sf_phases` only if `phases` is empty, and flag.

### 3.4 `metering_status` values (existing enum)

| Value | When the automation sets it |
|---|---|
| `Metering Application Sent` | Email sent, or manual task completed |
| `Meter request acknowledged by retailer` | Retailer reply detected (Phase 4) |
| `Metering Issues Not Sent On Hold` | Validation failed / missing data |
| `Metering Email Sent To Customer` | Existing manual use; don't set automatically |
| `Metering forms uploaded to Hubspot` | Existing manual use; don't set automatically |
| `Metering Not Needed (Existing Solar)` | Set when skip rules in §6.1 apply |

**Proposed new options** `[CONFIRM before adding]`: `Awaiting Manual Lodgement`, `Awaiting Customer Signature`, `Metering Completed`.

### 3.5 NEW properties to create (Phase 0) `[CONFIRM the list, then create via API]`

Group: create a property group `metering_automation` ("Metering Automation") on deals.

| Internal name | Label | Type / fieldType | Options / notes |
|---|---|---|---|
| `metering_retailer` | Metering Retailer (normalised) | enumeration / select | Canonical keys from §4.1. Written by n8n from `electricity__retailer`. Later the team can switch the form to this dropdown and retire free text. |
| `metering_route` | Metering Route | enumeration / select | `email_auto`, `portal_manual`, `phone_manual`, `unknown` |
| `network_approval_reference` | Network Approval Reference | string | Ausgrid job/CNL no., Endeavour PTC no., Essential CSO no. |
| `network_approval_letter_url` | Network Approval Letter (file URL) | string | HubSpot Files URL of the letter PDF (written by the PTC workflow extension). |
| `ccew_pdf_url` | CCEW PDF (file URL) | string | `[CONFIRM]` might already exist elsewhere. |
| `metering_application_date` | Metering Application Date | date | |
| `metering_application_ref` | Metering Application Reference | string | Retailer ticket/job no. if they reply with one. |
| `metering_last_chased` | Metering Last Chased | date | |
| `metering_completed_date` | Metering Completed Date | date | From Intellihub/retailer completion. |
| `property_ownership` | Property Ownership | enumeration | `Owner-occupier`, `Tenant`, `Landlord / investment` (EA needs a landlord letter if leased). |
| `account_holder_name` | Electricity Account Holder (if not primary contact) | string | Optional override. |
| `metering_automation_log` | Metering Automation Log | textarea | Append-only short log lines: `2026-09-23 10:04 sent EA email msgId=…`. |

Also create a **HubSpot ticket pipeline stage or category** `[CONFIRM]` for "Metering application" tickets, matching the team's habit of creating a ticket on the deal whenever something happens on a job.

---

## 4. Retailer routing

### 4.1 Normalisation map (`electricity__retailer` → `metering_retailer`)

Lowercase, trim, collapse spaces, strip punctuation, then match. Keep this map in a single **Code node** called `Normalise Retailer` (or a Google Sheet `[CONFIRM]` if Rodrigo wants the team to edit it).

| Canonical key | Raw values seen (not exhaustive) |
|---|---|
| `origin` | origin, origin energy, "origin " |
| `agl` | agl, agl energy |
| `energyaustralia` | energy australia, "energy australia ", energy aus, energy aust, enerrgy aus, energyaustralia |
| `red_energy` | red energy, redenergy, "red energy " |
| `powershop` | powershop |
| `engie` | engie |
| `alinta` | alinta energy, alinta |
| `globird` | globird, globird energy |
| `amber` | amber, amber electric |
| `first_energy` | energy locals, 1st energy, first energy |
| `momentum` | momentum energy, momentum |
| `discover` | discover energy |
| `nectr` | nectr |
| `ampol` | ampol energy, amopol energy |
| `blue_nrg` | blue nrg |
| `diamond` | diamond energy |
| `kogan` | kogan |
| `ovo` | ovo energy |
| `invalid` | tbd, tbc, tba, unknown, na, k, 0, numeric strings, aus grid (a distributor), free-text sentences |
| `blank` | empty |

`invalid` and `blank` → `metering_status = Metering Issues Not Sent On Hold`, create task "Retailer missing/invalid – confirm from customer's bill".

Deal counts at time of writing (Post Sale To Completion, merged): Origin 97, AGL 72, EnergyAustralia 69, Red 65, Powershop 11, ENGIE 9, Alinta 8, GloBird 7, Amber 5, Energy Locals 5, Momentum 5, Discover 3, Nectr 2, Ampol 2, Blue NRG/Diamond/Kogan/OVO 1 each. 218 blank, 28 invalid.

### 4.2 Route table

| Key | Route | Destination | Phase |
|---|---|---|---|
| `energyaustralia` | `email_auto` | `solarconnections@energyaustralia.com.au` | 1 |
| `agl` | `email_auto` (PDF fallback) | `aglnewconns@agl.com.au` | 2 |
| `globird` | `email_auto` | `cs@globirdenergy.com.au` | 2 |
| `amber` | `email_auto` | `info@amber.com.au` `[CONFIRM NSW docs]` | 2 |
| `first_energy` | `email_auto` once inbox confirmed; `phone_manual` until then | `[CONFIRM inbox]` | 2 |
| `origin` | `portal_manual` | Origin Connect (`originenergy.com.au/ocportal`) | 3 |
| `red_energy` | `phone_manual` (131 806) until route confirmed | `[CONFIRM: is solarenquiries@redenergy.com.au live?]` | 3 |
| `powershop`, `engie`, `alinta`, `momentum` | `phone_manual` | ENGIE 13 88 08 · Alinta 1300 669 950 · Momentum 1300 662 778 · Powershop `[CONFIRM]` | 3 |
| long tail | `phone_manual` | | 3 |

Store the route table as a **JSON config** in one Code node (`Retailer Config`) so adding a retailer is a one-line change. Shape:

```json
{
  "energyaustralia": {
    "route": "email_auto",
    "to": ["solarconnections@energyaustralia.com.au"],
    "cc": [],
    "subjectTemplate": "Solar meter alteration – NMI {{nmi}} – {{siteAddress}}",
    "handler": "ea",
    "needsCustomerSignature": true,
    "attachments": ["ea_form", "ccew", "network_letter", "landlord_letter_if_tenant"],
    "phone": "1800 818 378",
    "enabled": true
  }
}
```

Every retailer has an `enabled` flag. **Only `energyaustralia` is enabled at the end of Phase 1.**

---

## 5. Documents

### 5.1 Document inventory per retailer

| Retailer | Required | Nice to have |
|---|---|---|
| EnergyAustralia | EA "Service Works Request" form (NSW/ACT/SA new connection, alteration or solar upgrade), filled + signed by account holder; landlord permission letter if leased | CCEW, network letter |
| AGL | AGL Electricity application form (PDF) with: meter phases, REC name/licence/phone/ASP no. (alteration) or panel install date + inverter-on date (exchange); **homeowner meter request consent form** if we lodge on their behalf | network letter (Ausgrid CNL / Endeavour & Essential PTC) |
| GloBird | The distributor letter only: Ausgrid CNL / Endeavour Connection of Generator / Essential CSO | |
| Amber | Compliance certificate + network approval `[CONFIRM for NSW; their article names VIC's CES/EWR]` | |
| 1st Energy | Compliance certificate (CCEW) noting install date | |
| Origin (manual) | Data sheet for portal entry + CCEW + network letter ready to upload | |
| Phone routes (manual) | Data sheet + CCEW + network letter attached to the task | |

### 5.2 Retailer forms: get and inspect them

Download the current forms into `./forms/` and **inspect before coding**:

- EA: `https://www.energyaustralia.com.au/document/nsw-act-sa-new-connection-alteration-or-solar-upgrade` (also check `.../mandatory-fields-guide`). Solar section: tick "Solar alteration (add solar channel into meter)"; fields: site lot/unit/street/suburb/state/postcode, NMI or meter number, description of works, electrician first/last name, mobile, licence no., email, ABN, business name, account holder details, signature, date.
- AGL: `https://www.agl.com.au/content/dam/digital/agl/documents/help-and-support/agl1629_ncbau_electricity_application_form.pdf`. Also find the **meter request consent form** on AGL's new connections pages.

For each PDF:
1. Run `pdftk file.pdf dump_data_fields` (or `pypdf` `get_fields()`) to see if it is **fillable**.
2. **Fillable** → fill with field names (map in a JSON file `forms/<retailer>-fieldmap.json`).
3. **Not fillable** → overlay text with coordinates using `pdf-lib` (Node) or `reportlab` + `pypdf` merge. Store coordinates in the same fieldmap file. Render a preview PNG with poppler (`pdftoppm`) and check alignment visually.
4. Where to run the filling: prefer a tiny **filler service** (Python FastAPI or Node) in the n8n Docker Compose stack, called over HTTP from n8n, rather than giant Code nodes. `[CONFIRM]` Rodrigo is happy adding a container. If not, use an n8n Code node with `pdf-lib` (requires `NODE_FUNCTION_ALLOW_EXTERNAL=pdf-lib` and the module in the image).

**Signature fields are NOT filled by us.** The filled PDF goes to DocuSeal (§7) with a signature field placed for the account holder.

### 5.3 Getting the network letter and CCEW onto the deal

- **Network letter** (decided): new workflow `MTR – 05 Network Letter Intake`, running in parallel with the three existing distributor PTC workflows (left untouched). Only these three Gmail labels carry approval letters:

  | Distributor | Gmail label ID | Skip emails whose subject contains | Which PDF |
  |---|---|---|---|
  | Endeavour | `Label_5823373004158048354` | `Thank you for your Application Submission` | attachment whose filename contains `_PTC_` (case-insensitive) |
  | Ausgrid | `Label_3303489167417198909` | `Thank you for your Application Submission` | first attachment (`attachment_0`) |
  | Essential | `Label_592177598515650554` | `Essential Energy Connection Application Approved` (as the existing workflow does) | first attachment (`attachment_0`) |

  Gmail triggers poll every minute, download attachments, and never change labels or read state. **No backfill**: new emails only.
  1. Claude (Anthropic node) reads the chosen PDF → `{ nmi, reference, distributor, isApprovalLetter }`. If `isApprovalLetter` is false → stop quietly.
  2. Find the deal: search pipeline `978394588` by the first 10 characters of the NMI (the 11th is a checksum). 0 or >1 matches → alert to Rodrigo, stop.
  3. Upload the PDF to HubSpot Files (`metering/network-letters/`, private), attach it to the deal via a note, write `network_approval_letter_url` and `network_approval_reference`; fill `electricity_distributor` if blank.
  4. If the deal is on hold only for a missing network letter, re-run `MTR – 01` for that deal.
- **CCEW PDF**: `[CONFIRM]` source. Options: (a) the ccew-form app writes it to HubSpot → read `ccew_pdf_url`; (b) it's in Google Drive → search by NMI; (c) from GreenDeal. Do not build this until confirmed.

---

## 6. Workflows

### 6.0 Overview

| Workflow | Trigger | Job |
|---|---|---|
| `MTR – 01 Trigger & Router` | Gmail trigger (Rod's Impressive Batteries' Email), label `Metering 2.0` | Deal ID from subject → fetch deal, validate, normalise, route |
| `MTR – 10 EA Handler` | Execute Workflow (sub) | Fill EA form, Impressive signs as applicant, email EA (no DocuSeal) |
| `MTR – 11 AGL Handler` | sub | Fill AGL PDF (+ consent) → DocuSeal → email |
| `MTR – 12 GloBird Handler` | sub | Email network letter |
| `MTR – 13 Amber Handler` | sub | Email docs |
| `MTR – 14 1st Energy Handler` | sub | Email docs |
| `MTR – 20 Manual Task Handler` | sub | Data sheet + HubSpot task (Origin, phone routes, invalid retailer) |
| `MTR – 30 DocuSeal Completed` | Webhook from DocuSeal | Download signed PDF → call the retailer's send step |
| `MTR – 40 Chaser` | Schedule daily 8am AEST | Day-10 chase email, day-20 escalation task |
| `MTR – 41 Reply Watcher` | Gmail trigger on the sending mailbox, label `Metering/Replies` | Detect retailer acknowledgements, capture reference |
| `MTR – 05 Network Letter Intake` | Gmail trigger, same label as PTC Approval DER (read-only, parallel) | Extract NMI/job no., attach letter to deal |
| `MTR – 42 Completion Hook` | Own Gmail trigger on the Intellihub "ORDER COMPLETED" emails (parallel to existing parser, which is untouched) | Extract NMI, mark completed |
| `MTR – 99 Error Handler` | n8n Error Trigger | Gmail alert to Rodrigo with execution link |

Set `MTR – 99` as the **error workflow** on every MTR workflow.

### 6.1 `MTR – 01 Trigger & Router`

***Trigger (decided).** A HubSpot workflow emails Rodrigo when a deal meets the criteria (deal stage, job status, NMI present, etc.). A Gmail filter applies the label `Metering 2.0`. `MTR – 01` uses a **Gmail Trigger** on n8n credential *Rod's Impressive Batteries' Email*, filtered to that label, polling every minute.

1. **Deal ID** = the digits in the email subject (ignore `Fwd:`/other text). No number → label `Metering 2.0 - Error`, alert, stop.
2. The email is only a signal: **all data comes from the HubSpot deal** fetched by ID.
3. **Duplicate guard**: if `metering_status` already has a value → label `Metering 2.0 - Processed`, stop (no auto-retry; a human clears the status to retry).
4. Re-check NMI and retailer even though the HubSpot criteria cover them (fields can change after the email).
5. On finish, add label `Metering 2.0 - Processed` (success) or `Metering 2.0 - Error` (failure). The trigger itself never removes labels.

roperties to fetch: every READ property in §3.2 plus the new ones.

**Steps:**
1. **Fetch associations**: primary contact (account holder), and existing notes/files if needed.
2. **Skip rules** → set `metering_status = Metering Not Needed (Existing Solar)`, log, stop:
   - `installation_type = Battery Only` **and** `existing_smart_meter` starts with `Yes` `[CONFIRM rule]`.
3. **Normalise retailer** (§4.1) → write `metering_retailer`.
4. **Validate** (collect all problems, not just the first):
   - `nmi` present and 10–11 alphanumeric chars
   - `electricity_distributor` in {Ausgrid, Endeavour, Essential}
   - `ptc_status = Received No Issues`
   - `ccew_status = Lodged` and `ccew_receipt_number` present
   - Retailer-specific required docs available (§5.1), e.g. `network_approval_letter_url` for GloBird
   - Contact has first name, last name, email, mobile
   - Site address complete
   - `installer` set (to pick REC details)
5. On validation failure → `metering_status = Metering Issues Not Sent On Hold`, append log, create **task** on the deal owned by `[CONFIRM: admin owner id]` titled `Metering blocked – <reasons>`, stop.
6. **Lock**: write `metering_status = Awaiting Manual Lodgement` or a temporary lock value `[CONFIRM new option]` before calling the handler, so a second poll can't double-send. (If no new option is approved, write `metering_automation_log` line `LOCK <executionId>` and check for it.)
7. **Route**: look up `Retailer Config`; if `enabled=false` → Manual Task Handler; else Execute the handler sub-workflow with a single normalised **Job object** (§6.2).

### 6.2 Job object (passed to every handler)

```json
{
  "dealId": "123",
  "dealName": "Smith – 6.6kW + 10kWh",
  "dealUrl": "https://app-ap1.hubspot.com/contacts/441838848/record/0-3/123",
  "retailerKey": "energyaustralia",
  "route": "email_auto",
  "nmi": "4103xxxxxx",
  "distributor": "Ausgrid",
  "networkApproval": { "reference": "…", "letterUrl": "…" },
  "ccew": { "receipt": "…", "date": "2026-09-20", "pdfUrl": "…" },
  "install": { "type": "Solar & Battery", "date": "2026-09-18", "completionDate": "2026-09-18" },
  "meter": { "phases": "Single Phase", "typeRequired": "Single Phase Solar Meter", "existingSmart": "No", "controlledLoad": false },
  "site": { "unit": "", "streetNumber": "12", "street": "Example St", "suburb": "Miranda", "state": "NSW", "postcode": "2228", "lot": "", "dp": "" },
  "accountHolder": { "firstName": "", "lastName": "", "email": "", "mobile": "", "ownership": "Owner-occupier" },
  "contractor": { "business": "…", "abn": "…", "recLicence": "…", "aspNumber": "…", "contactName": "…", "phone": "…", "email": "…" },
  "derRegister": "…",
  "dryRun": true
}
```

**Contractor block** (decided): always Impressive, from `config/contractors.json` (`impressive`). Business name, ABN, ACN, email and phone are filled; electrician name, mobile and licence number are `[CONFIRM]`.

### 6.3 `MTR – 10 EA Handler` (Phase 1: build this first, fully)

Form: `forms/ea.pdf` (EA "Service Works request for electricity", 2024 edition, supplied by Rodrigo). It is a **fillable AcroForm** with generic field names; `forms/ea-fieldmap.json` maps each one to its printed label and to a job-object path. `forms/ea-sample-filled.pdf` is a sample fill with dummy data.

**Impressive is the applicant and signs** (decided). No DocuSeal for EA: the form is filled, signed with the signatory's signature image and today's date, and sent straight away.

Data sources (decided):
- **Applicant (section 8)** = Impressive: signatory name/mobile `[CONFIRM]`, business name, ABN, email, landline from `config/contractors.json`.
- **Electrician (section 6)** = nominated supervisor **Sam Husband**, licence **279684C**, Impressive business details. Section 7 (Level 2) left blank.
- **Account holder** = the deal's primary contact. Their name goes at the start of the description of works (it is not asked for anywhere else on the form) and in the email body.
- **System size** = `sf_system_size_kw_stc`.
- **Off peak** = `dedicated_controlled_load`: `Yes - Add` → Yes + "ADD DEDICATED CONTROLLED LOAD"; `Yes - Remove` → Yes + "REMOVE CONTROLLED LOAD"; `No` → No; blank → hold + task.
- **CCEW PDF** = file on a HubSpot note on the deal whose attachment name starts with `CCEW ` (e.g. `CCEW 1234567`); receipt number from `ccew_receipt_number`. Missing, or numbers differ → hold + alert.
- **Replies** from EA can go to any address; the form uses `ccew@impressivebatteries.com.au`.

Steps:
1. Fill with `src/fillEaForm.js` (pdf-lib; `buildEaJob` then `fillEaForm`), per `forms/ea-fieldmap.json`. The output is flattened. Ticks: Solar alteration; Residential; off peak per above; phase change No; Solar system New.
2. If `property_ownership` is not Owner-occupier → task "Get landlord permission letter", hold, stop (EA requires the owner's letter for leased premises).
3. Stamp the signature image into `Signature79` and today's date into `Text78`. Upload the signed form to HubSpot Files (`metering/signed-forms/`) and note it on the deal.
4. Email EA from Rod's Impressive Batteries' Email:
   - To: `solarconnections@energyaustralia.com.au`
   - Subject: `Solar meter alteration – NMI {{nmi}} – {{street}}, {{suburb}}`
   - Body: §8.1, signed **Impressive Team**
   - Attach: signed EA form, CCEW PDF, network letter.
5. After send: `metering_status = Metering Application Sent`, `metering_application_date = today`, log Gmail message + thread ID, create ticket "Metering application lodged – EnergyAustralia", and **move the deal to stage `1509971393`** ("Install Complete and metering forms submitted for first time PV installations…").

### 6.4 `MTR – 11 AGL Handler` (Phase 2)

- Primary AGL channel is their online new connections platform; we use the **PDF + email fallback** that AGL publishes.
- Decide **alteration vs exchange**: `existing_smart_meter = No` → exchange; else alteration `[CONFIRM mapping]`.
  - Alteration fields: number of meter phases, REC name, licence no., contact number, FSP/ASP number.
  - Exchange fields: panel install date (`installation_date`), inverter switch-on date (`installation_completion_date`).
- Because we lodge on the homeowner's behalf, the **meter request consent form** must be signed by the homeowner → DocuSeal packet with **both** documents.
- Supply address and meter details must match the latest AGL invoice. `[CONFIRM]` whether we have the bill on file (HubSpot file? `average_electricity_bill` suggests bills are collected at sale).
- To: `aglnewconns@agl.com.au`. Subject: `Solar meter {{alteration|exchange}} – NMI {{nmi}} – {{address}}`.

### 6.5 `MTR – 12 GloBird Handler` (Phase 2)

- No signature needed. Attach the distributor letter only.
- Validate the letter type matches the distributor (CNL for Ausgrid, Connection of Generator for Endeavour, CSO for Essential). The PTC extension should store a `letterType` in the log; if unknown → hold.
- To: `cs@globirdenergy.com.au`. Subject: `Solar meter configuration – NMI {{nmi}} – {{address}}`.
- GloBird replies with timeframe/charges/consent needed → Reply Watcher flags it for a human.

### 6.6 `MTR – 13 Amber`, `MTR – 14 1st Energy` (Phase 2)

Simple email handlers: CCEW + network letter + install date in body. **Disabled until the `[CONFIRM]` items in §4.2 are resolved.**

### 6.7 `MTR – 20 Manual Task Handler` (Phase 3)

For Origin, phone routes and anything disabled/unknown:

1. Build a **data sheet** (PDF or HTML-to-PDF via the filler service; plain HubSpot note is acceptable for v1) with every Job field laid out in the order Origin Connect asks for them `[CONFIRM order after someone does one Origin submission and screenshots the form]`.
2. Create a HubSpot **task** on the deal:
   - Title: `Lodge metering – {{Retailer}} ({{route}}) – NMI {{nmi}}`
   - Body: retailer phone/portal link, the data sheet, links to CCEW and network letter, and the three questions to ask phone-route retailers the first time (which inbox, which documents per distributor, can an installer lodge with signed customer authority).
   - Owner: `[CONFIRM admin owner id]`; due: +1 business day.
3. `metering_status = Awaiting Manual Lodgement` `[CONFIRM option]`.
4. Poll tasks (in `MTR – 40`): when the task is completed → set `Metering Application Sent`, date, stage move.

### 6.8 `MTR – 30 DocuSeal Completed`

- DocuSeal webhook `submission.completed` → n8n Webhook node (path `mtr-docuseal`, secret header check).
- Read `external_id` = `dealId` (set when creating the submission).
- Download the signed PDF, upload to HubSpot Files (`metering/signed-forms/`), note on deal, then call the retailer handler's **send step** (split each email handler into `prepare` and `send` sub-workflows so the send can be called from here).
- DocuSeal `submission.expired` / declined → task + status hold.
- Reminder: DocuSeal's own reminders at 2 and 5 days `[CONFIRM]`.

### 6.9 `MTR – 40 Chaser` (Phase 4)

Daily 08:00 Australia/Sydney. Deals with `metering_status = Metering Application Sent` and no `metering_completed_date`:
- **Business day 10** since `metering_application_date` and `metering_last_chased` empty → reply **in the same Gmail thread** with §8.2, set `metering_last_chased`.
- **Business day 20** → task "Escalate metering with {{retailer}}" + Gmail summary to Rodrigo.
- Use NSW public holidays for business-day maths (hard-code a list for 2026–2027 in a Code node, or use a holidays API).

### 6.10 `MTR – 41 Reply Watcher`

- Gmail trigger on sending mailbox, only threads we created (store thread IDs in `metering_automation_log`, or apply label `Metering/Sent` on send and `Metering/Replies` via Gmail filter).
- Anthropic node classifies the reply: `acknowledged` (with reference no.), `more_info_needed`, `rejected`, `completed`, `other`. Extract reference numbers and requested items.
- `acknowledged` → `Meter request acknowledged by retailer`, write `metering_application_ref`.
- Anything else → task for a human with the email summary. **Never auto-reply to retailer questions.**

### 6.11 `MTR – 42 Completion Hook`

- At the end of the existing **Intellihub ORDER COMPLETED** parser: find deal by NMI → set `metering_completed_date`, status `Metering Completed` `[CONFIRM option]`, log, close the metering ticket.
- Other metering providers (Plus ES, Vector, etc.) send different emails `[CONFIRM samples]`; add parsers later.

---

## 7. DocuSeal

- API base: `https://docuseal.impressivebatteries.com.au/api`, auth header `X-Auth-Token` (n8n credential, Header Auth).
- One **template per retailer form** created from the filled-PDF approach: simplest is `POST /submissions/pdf` (or the "create submission from PDF" endpoint in the installed version; **check the version's API docs first**) with the filled PDF and a signature + date field positioned for role `Account Holder`.
- Set `external_id = dealId`, `send_email = true`, message from Impressive branding (subject: `Please sign your solar meter request – {{street}}`).
- Configure the DocuSeal webhook to `https://n8n.nuevaenergy.com.au/webhook/mtr-docuseal`.

---

## 8. Email templates

Plain, professional, Arial-style plain text (brand guide: emails in Arial/Calibri; tone approachable, professional, plain-spoken). Sign-off from the sending mailbox owner `[CONFIRM name/title]`.

### 8.1 Application email (EA example)

```
Subject: Solar meter alteration – NMI {{nmi}} – {{street}}, {{suburb}}

Hi EnergyAustralia Solar Connections team,

Please find attached a solar meter alteration request for your customer:

Customer: {{accountHolder.firstName}} {{accountHolder.lastName}}
Site: {{fullAddress}}
NMI: {{nmi}}
Distributor: {{distributor}} – approval ref {{networkApproval.reference}}
Solar installed: {{install.date}} (inverter switched on {{install.completionDate}})
CCEW: {{ccew.receipt}}

Attached:
- Service Works Request (signed by Impressive as applicant)
- CCEW
- {{distributor}} network approval letter

The system is switched off pending meter work. Please let us know if you need anything else.

Kind regards,
Impressive Team
{{contractor.business}} | {{contractor.phone}}
```

### 8.2 Day-10 chase (same thread)

```
Hi team,

Following up on the request below for NMI {{nmi}} ({{street}}, {{suburb}}), sent {{metering_application_date}}.
Could you confirm it has been raised with your metering provider and share the reference number?

Thanks,
{{sender.name}}
```

---

## 9. Dry run, idempotency and safety

- **`DRY_RUN`**: a single n8n **Variable** `MTR_DRY_RUN` (`true`/`false`). When true:
  - All outbound email `to` → `[CONFIRM internal test address]`, subject prefixed `[DRY RUN → retailer@…]`.
  - DocuSeal submissions go to the internal test address.
  - No stage moves; no property writes except `metering_automation_log` lines prefixed `[DRY RUN]`.
- **Per-retailer kill switch**: `enabled` in Retailer Config.
- **Idempotency**: before sending, re-read the deal; if `metering_application_date` is set, **do not send**. Store Gmail message IDs in the log.
- **Rate**: process max 10 deals per poll run.
- **PII**: no customer data in n8n execution logs beyond what n8n keeps by default; set execution data pruning `[CONFIRM current setting]`.
- **Never** email a retailer from a workflow that failed validation. **Never** guess an NMI.

---

## 10. Testing plan

1. **Phase 0**: property creation script run against HubSpot in a single approved batch. Backfill `metering_retailer` for all deals in the pipeline; print a table of raw → normalised for Rodrigo to eyeball.
2. **Form filling**: render filled EA/AGL PDFs for 3 real deals to PNG; Rodrigo checks them.
3. **Phase 1 dry run**: run on 5 deals currently in `1879662022` (or temporarily test on recently completed deals by passing their IDs manually via a **Manual Trigger with dealId input**, bypassing the stage filter). All emails go to the test inbox.
4. **Phase 1 live**: one real EA deal, Rodrigo watching. Then enable.
5. Repeat per retailer.
6. Keep a `TESTING.md` with each run: date, deal IDs, result, fixes.

## 11. Acceptance criteria (Phase 1 done when…)

- [ ] A deal entering `1879662022` with EA as retailer and all data valid results in: EA form filled and signed by Impressive → one email to EA with 3 attachments → status, date, log, ticket and stage all updated. No human touch.
- [ ] Invalid data results in a hold status + a task listing every problem.
- [ ] Running the poll twice never double-sends.
- [ ] Dry run mode sends nothing externally.
- [ ] Workflow JSON exported to `./workflows/`, config and fieldmaps in `./forms/` and committed.

---

## 12. Open questions for Rodrigo (answer before Phase 1)

1. Sending mailbox for retailer emails, and whose name signs them.
2. Internal test address for dry runs.
3. Where the final **CCEW PDF** lives, and whether a property already holds its URL.
4. How **Ausgrid CNLs** and **Essential CSO letters** arrive (same Gmail label as Endeavour PTCs? filename pattern?).
5. Contractor details for `Impressive,` and `Energy Flow`: business name, ABN, REC licence, ASP level/number, contact name, phone, email.
6. HubSpot owner ID who should own manual tasks (admin person).
7. Approve the new properties (§3.5) and new `metering_status` options (§3.4).
8. Should the automation move the deal stage, or only set `metering_status`?
9. Skip rule for battery-only jobs with existing solar: correct?
10. OK to add a small PDF filler container to the n8n Docker Compose stack?
11. Is the primary associated contact always the electricity account holder?
12. System size property to use in the "description of works" line.

## 13. Retailer facts to re-verify before enabling each handler

Retailers change their processes (Origin moved from email to portal; Energy Locals became 1st Energy, old links stop 1 Dec 2026). Before enabling a handler, open the retailer's page and confirm the inbox and document list are unchanged:

- EnergyAustralia form PDF + `solarconnections@energyaustralia.com.au`, help 1800 818 378
- AGL solar meter installation page + `aglnewconns@agl.com.au`, help 1800 680 430
- GloBird "Additions and Alterations" page + `cs@globirdenergy.com.au`
- Amber help article "I have just had solar installed…" + `info@amber.com.au`
- 1st Energy "I plan to or have installed solar – what happens next?"
- Origin `originenergy.com.au/connections/change` (Origin Connect)
- Red Energy: call 131 806 and ask whether `solarenquiries@redenergy.com.au` is live
