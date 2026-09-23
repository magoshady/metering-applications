# HubSpot setup for the metering automation

Settings → Properties → **Deal properties** → Create property.
Put them all in a new group **Metering Automation**.

The **internal name** must match exactly (the workflows use it). HubSpot builds it from the label, so type the label below and check the internal name before saving.
For dropdowns, leave each option's internal value the same as its label.

| # | Label | Internal name | Field type | Options |
|---|---|---|---|---|
| 1 | Metering Retailer | `metering_retailer` | Dropdown select | Origin, AGL, EnergyAustralia, Red Energy, Powershop, ENGIE, Alinta Energy, GloBird, Amber, 1st Energy, Momentum Energy, Discover Energy, Nectr, Ampol Energy, Blue NRG, Diamond Energy, Kogan Energy, OVO Energy, Invalid, Blank |
| 2 | Metering Route | `metering_route` | Dropdown select | Email, Portal, Phone, Unknown |
| 3 | Network Approval Reference | `network_approval_reference` | Single-line text | |
| 4 | Network Approval Letter URL | `network_approval_letter_url` | Single-line text | |
| 5 | Metering Application Date | `metering_application_date` | Date picker | |
| 6 | Metering Application Ref | `metering_application_ref` | Single-line text | |
| 7 | Metering Last Chased | `metering_last_chased` | Date picker | |
| 8 | Metering Completed Date | `metering_completed_date` | Date picker | |
| 9 | Metering Automation Log | `metering_automation_log` | Multi-line text | |
| 10 | Property Ownership *(only if you want the landlord-letter check)* | `property_ownership` | Dropdown select | Owner-occupier, Tenant, Landlord / investment |

## New options on the existing **Metering Status** (`metering_status`) property

Add, leaving the existing options as they are:

- `Awaiting Manual Lodgement`
- `Metering Completed`
- `Awaiting Customer Signature` *(only if AGL needs the customer to sign)*

When done, tell Claude; it checks every name and option through the API before building.
