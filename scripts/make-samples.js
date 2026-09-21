// Generates sample contract PDFs (samples/*.pdf) plus offline extraction fixtures
// (samples/fixtures/<sha256>.json). Dates are relative to today so expiry alerts are live.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { ROOT } from '../server/config.js';
import { pdfPageTexts, splitParagraphs } from '../server/pdf.js';

const OUT = path.join(ROOT, 'public', 'samples'); // PDFs are served statically
const FIX = path.join(ROOT, 'samples', 'fixtures'); // offline extraction results, bundled with the API function
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(FIX, { recursive: true });

const today = new Date(); today.setUTCHours(0, 0, 0, 0);
const plusDays = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + n); return d; };
const iso = (d) => d.toISOString().slice(0, 10);
const long = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// Item shapes: {h} heading | {c, t} numbered clause | {t} plain paragraph
function render(file, pages) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 60, info: { Title: file } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    pages.forEach((items, i) => {
      if (i > 0) doc.addPage();
      for (const it of items) {
        if (it.h) doc.font('Helvetica-Bold').fontSize(it.big ? 16 : 11).moveDown(0.6).text(it.h, { align: it.big ? 'center' : 'left' }).moveDown(0.3);
        else doc.font('Helvetica').fontSize(10.5).text(it.c ? `${it.c} ${it.t}` : it.t, { lineGap: 2 }).moveDown(0.5);
      }
    });
    doc.end();
  });
}

const F = (value, confidence, refs, rationale) => ({ value, confidence, refs, rationale });

async function build(file, pages, makeFixture) {
  const buf = await render(file, pages);
  fs.writeFileSync(path.join(OUT, file), buf);
  const paras = splitParagraphs(await pdfPageTexts(buf));
  const byClause = (c) => { const p = paras.find((x) => x.clause === c); if (!p) throw new Error(`${file}: no clause ${c}`); return p.id; };
  const byText = (s) => { const p = paras.find((x) => x.text.includes(s)); if (!p) throw new Error(`${file}: no text "${s}"`); return p.id; };
  const R = (...specs) => specs.map((s) => (typeof s === 'string' && /^\d+\.\d+/.test(s) ? byClause(s) : byText(s)));
  const fx = makeFixture(R);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(path.join(FIX, `${sha}.json`), JSON.stringify({ file, ...fx }, null, 2));
  console.log(`✓ ${file}  (${paras.length} paragraphs, ${pages.length} pages)  sha ${sha.slice(0, 10)}…`);
}

// ---------------------------------------------------------------- 1. Nimbus SaaS MSA (business, risky)
const E1 = plusDays(20 - 365);
const X1 = plusDays(20);
await build('nimbus-master-services-agreement.pdf', [
  [
    { h: 'MASTER SERVICES AGREEMENT', big: true },
    { t: `This Master Services Agreement (the "Agreement") is entered into on ${long(E1)} (the "Effective Date") between Nimbus Cloud Solutions Pvt Ltd, a company incorporated in India ("Provider"), and Acme Traders Pvt Ltd ("Customer").` },
    { h: 'SERVICES' },
    { c: '1.1', t: 'Provider shall make its cloud-based inventory and billing platform (the "Platform") available to Customer and shall provide the services described in Schedule A.' },
    { c: '1.2', t: 'Provider shall maintain Platform availability of at least 99.5% per calendar month, measured excluding scheduled maintenance.' },
    { c: '1.3', t: 'Provider shall provide customer support by email and telephone during business hours (9:00 to 18:00 IST, Monday to Friday) and shall respond to critical incidents within four (4) hours.' },
    { c: '1.4', t: 'Provider shall perform daily backups of Customer Data and retain them for thirty (30) days.' },
  ],
  [
    { h: 'TERM AND RENEWAL' },
    { c: '2.1', t: 'This Agreement commences on the Effective Date and continues for an initial term of twelve (12) months (the "Initial Term").' },
    { c: '2.2', t: 'Upon expiry of the Initial Term, this Agreement shall automatically renew for successive periods of twelve (12) months (each a "Renewal Term") unless either party gives written notice of non-renewal at least sixty (60) days before the end of the then-current term.' },
    { c: '2.3', t: 'Provider may increase the Fees for any Renewal Term by up to twenty percent (20%) by notifying Customer no later than thirty (30) days before the Renewal Term begins.' },
    { h: 'FEES AND PAYMENT' },
    { c: '3.1', t: 'Customer shall pay Provider a subscription fee of USD 4,500 per month, invoiced monthly in advance.' },
    { c: '3.2', t: 'Invoices are payable within fifteen (15) days of the invoice date.' },
    { c: '3.3', t: 'Any amount not paid when due shall incur a late payment charge of three percent (3%) per month on the outstanding amount, in addition to a fixed penalty of USD 250 per late invoice.' },
    { c: '3.4', t: 'Provider may suspend the Services immediately, without notice, if any invoice remains unpaid for seven (7) days.' },
  ],
  [
    { h: 'TERMINATION' },
    { c: '4.1', t: 'Provider may terminate this Agreement at any time, for any reason or no reason, by giving Customer fifteen (15) days\' written notice.' },
    { c: '4.2', t: 'Customer may terminate this Agreement only for Provider\'s material breach that remains uncured for sixty (60) days after written notice. Customer has no right to terminate for convenience.' },
    { c: '4.3', t: 'On early termination by Customer for any reason, Customer shall pay all Fees for the remainder of the then-current term as liquidated damages.' },
    { h: 'LIABILITY AND INDEMNITY' },
    { c: '5.1', t: 'Customer shall indemnify, defend and hold harmless Provider from any and all claims, losses, damages and expenses arising out of Customer\'s use of the Platform, without limit as to amount.' },
    { c: '5.2', t: 'Provider\'s total aggregate liability under this Agreement shall not exceed the Fees paid by Customer in the one (1) month preceding the claim.' },
    { h: 'GENERAL' },
    { c: '6.1', t: 'This Agreement is governed by the laws of India and the courts at Bengaluru shall have exclusive jurisdiction.' },
    { c: '6.2', t: 'Neither party may assign this Agreement without the prior written consent of the other, except that Provider may assign it to any affiliate or successor without consent.' },
    { t: 'Signed for Nimbus Cloud Solutions Pvt Ltd: Rohit Verma, Director.   Signed for Acme Traders Pvt Ltd: Priya Nair, Head of Operations.' },
  ],
], (R) => ({
  title: 'Nimbus Cloud – Master Services Agreement',
  contract_type: 'business_class',
  vendor_name: 'Nimbus Cloud Solutions Pvt Ltd',
  doc_quality: 'Clean digital PDF, fully legible.',
  fields: {
    parties: F([{ name: 'Nimbus Cloud Solutions Pvt Ltd', role: 'Provider' }, { name: 'Acme Traders Pvt Ltd', role: 'Customer' }], 'high', R('entered into on'), 'Both parties named in the preamble.'),
    effective_date: F(iso(E1), 'high', R('entered into on'), 'Stated as the Effective Date.'),
    expiration_date: F(iso(X1), 'medium', R('2.1'), 'Not stated as a date; computed as Effective Date + 12-month Initial Term.'),
    renewal_terms: F('Renews automatically for successive 12-month terms unless either party gives written non-renewal notice at least 60 days before the end of the current term. Provider may raise fees by up to 20% on renewal with 30 days\' notice.', 'high', R('2.2', '2.3'), 'Explicit renewal clause.'),
    payment_terms: F({ amount: 4500, currency: 'USD', recurrence: 'monthly', due_rule: 'Invoiced monthly in advance; payable within 15 days of invoice date.' }, 'high', R('3.1', '3.2'), 'Fee, cadence and due rule all stated.'),
    termination_conditions: F('Provider may terminate at any time for any reason on 15 days\' notice. Customer may terminate only for Provider\'s uncured material breach (60-day cure) and must pay all remaining fees on early termination.', 'high', R('4.1', '4.2', '4.3'), 'Explicit termination clauses.'),
    service_obligations: F(['Provide the cloud inventory and billing platform (Schedule A services)', '99.5% monthly platform availability', 'Email/phone support 9:00–18:00 IST Mon–Fri; critical incidents answered within 4 hours', 'Daily backups retained for 30 days'], 'high', R('1.1', '1.2', '1.3', '1.4'), 'Listed in Article 1.'),
  },
  flags: [
    { flag_type: 'auto_renewal', description: 'Auto-renews for 12 months unless notice is given 60 days before term end. Check whether that notice deadline has already passed relative to the expiry date.', source_ref: R('2.2')[0] },
    { flag_type: 'other', description: 'Provider can raise fees by up to 20% on each renewal with only 30 days\' notice.', source_ref: R('2.3')[0] },
    { flag_type: 'penalty', description: 'Late payments carry 3% per month interest PLUS a fixed USD 250 penalty per late invoice.', source_ref: R('3.3')[0] },
    { flag_type: 'other', description: 'Provider may suspend service immediately, with no notice, after only 7 days of non-payment.', source_ref: R('3.4')[0] },
    { flag_type: 'unilateral_termination', description: 'Provider may terminate at any time for any reason on 15 days\' notice; Customer has no equivalent right.', source_ref: R('4.1')[0] },
    { flag_type: 'penalty', description: 'If Customer terminates early it must pay ALL remaining fees for the term as liquidated damages, and Customer can only terminate for cause.', source_ref: R('4.3')[0] },
    { flag_type: 'indemnity', description: 'Customer gives an uncapped one-way indemnity, while Provider\'s own liability is capped at one month of fees.', source_ref: R('5.1')[0] },
  ],
  summary: 'This is a one-year subscription to Nimbus Cloud\'s inventory and billing software at USD 4,500 a month, paid within 15 days of each invoice. It renews itself for another year unless you tell Nimbus in writing at least 60 days before the year ends, and Nimbus may raise the price by up to 20% when it does. Nimbus can end the deal at any time with 15 days\' notice, but you can only leave if Nimbus seriously breaks the contract, and leaving early means paying for the rest of the term. Late payments are charged heavily (3% a month plus USD 250 per invoice) and Nimbus can cut off service after just 7 days unpaid. You also promise to cover Nimbus for any claims from your use of the software with no cap, while Nimbus\'s own liability is limited to about one month of fees. Several of these terms favour Nimbus heavily and are worth a careful look before renewal.',
}));

// ---------------------------------------------------------------- 2. Apartment lease (customer)
const E2 = plusDays(52 - 334);
const X2 = plusDays(52);
await build('sunrise-apartment-lease.pdf', [
  [
    { h: 'RESIDENTIAL LEASE AGREEMENT', big: true },
    { t: `This Lease Agreement is made on ${long(E2)} between Sunrise Properties LLP ("Landlord") and Aarav Mehta ("Tenant") for the residential premises at Flat 4B, Lakeview Residency, Pune (the "Premises").` },
    { h: 'TERM AND RENT' },
    { c: '1.1', t: `The lease begins on ${long(E2)} and shall expire on ${long(X2)}, a period of eleven (11) months.` },
    { c: '1.2', t: 'Tenant shall pay monthly rent of INR 32,000, due on or before the 5th day of each month.' },
    { c: '1.3', t: 'Tenant has paid a refundable security deposit of INR 96,000, which does not earn interest.' },
    { c: '1.4', t: 'If rent is paid after the due date, Tenant shall pay a late fee of INR 500 for each day of delay.' },
    { h: 'RENEWAL' },
    { c: '2.1', t: 'This lease shall renew automatically for a further eleven (11) months on the same terms, with rent increased by ten percent (10%), unless either party gives written notice of non-renewal at least thirty (30) days before expiry.' },
  ],
  [
    { h: 'TERMINATION' },
    { c: '3.1', t: 'Landlord may terminate this lease at any time by giving Tenant thirty (30) days\' written notice if Landlord requires the Premises for personal use or for any other reason.' },
    { c: '3.2', t: 'Tenant may terminate this lease before expiry only by giving sixty (60) days\' written notice, and shall forfeit the entire security deposit if the Premises are vacated before the end of the term.' },
    { h: 'TENANT OBLIGATIONS' },
    { c: '4.1', t: 'Tenant shall use the Premises for residential purposes only and shall not sublet the Premises or any part of it.' },
    { c: '4.2', t: 'Tenant shall pay electricity, water and internet charges directly and shall bear the cost of minor repairs up to INR 2,000 per incident.' },
    { c: '4.3', t: 'Tenant shall pay the monthly society maintenance charge of INR 3,500 along with rent.' },
    { c: '4.4', t: 'Landlord shall return the security deposit within thirty (30) days of Tenant vacating, less any deductions for damage beyond normal wear and tear.' },
    { t: 'Signed: Sunrise Properties LLP (Landlord) and Aarav Mehta (Tenant).' },
  ],
], (R) => ({
  title: 'Flat 4B Lakeview Residency – Lease',
  contract_type: 'business_class',
  vendor_name: 'Sunrise Properties LLP',
  doc_quality: 'Clean digital PDF, fully legible.',
  fields: {
    parties: F([{ name: 'Sunrise Properties LLP', role: 'Landlord' }, { name: 'Aarav Mehta', role: 'Tenant' }], 'high', R('This Lease Agreement is made on'), 'Named in the preamble.'),
    effective_date: F(iso(E2), 'high', R('1.1'), 'Lease start date stated in clause 1.1.'),
    expiration_date: F(iso(X2), 'high', R('1.1'), 'Expiry date stated explicitly in clause 1.1.'),
    renewal_terms: F('Renews automatically for another 11 months at 10% higher rent unless either party gives written notice at least 30 days before expiry.', 'high', R('2.1'), 'Explicit renewal clause.'),
    payment_terms: F({ amount: 32000, currency: 'INR', recurrence: 'monthly', due_rule: 'Due on or before the 5th of each month; INR 500/day late fee. Plus INR 3,500 monthly society maintenance.' }, 'high', R('1.2', '1.4', '4.3'), 'Rent amount and due day stated.'),
    termination_conditions: F('Landlord may terminate on 30 days\' notice for any reason. Tenant must give 60 days\' notice and forfeits the whole INR 96,000 deposit if leaving before the term ends.', 'high', R('3.1', '3.2'), 'Explicit termination clauses.'),
    service_obligations: F(['Landlord: return the security deposit within 30 days of vacating, less damage deductions', 'Tenant: residential use only, no subletting', 'Tenant: pay utilities directly and minor repairs up to INR 2,000 per incident', 'Tenant: pay INR 3,500 monthly society maintenance'], 'medium', R('4.1', '4.2', '4.3', '4.4'), 'Obligations are spread across several clauses; list may not be exhaustive.'),
  },
  flags: [
    { flag_type: 'auto_renewal', description: 'Lease renews automatically for 11 more months with a 10% rent increase unless you give notice 30+ days before expiry.', source_ref: R('2.1')[0] },
    { flag_type: 'unilateral_termination', description: 'Landlord may end the lease on 30 days\' notice for any reason, while you must give 60 days.', source_ref: R('3.1')[0] },
    { flag_type: 'penalty', description: 'Leaving early forfeits the ENTIRE INR 96,000 deposit, however short the remaining term.', source_ref: R('3.2')[0] },
    { flag_type: 'penalty', description: 'Late rent costs INR 500 per day, which adds up quickly.', source_ref: R('1.4')[0] },
  ],
  summary: 'This is an 11-month lease for Flat 4B at Lakeview Residency. You pay INR 32,000 rent by the 5th of each month, plus INR 3,500 society maintenance and your own utilities, and you have put down a INR 96,000 deposit. The lease renews itself for another 11 months at 10% higher rent unless you or the landlord give written notice at least 30 days before it ends. The landlord can end it with 30 days\' notice for any reason, but you need to give 60 days\' notice, and if you leave early you lose the whole deposit. Late rent costs INR 500 a day.',
}));

// ---------------------------------------------------------------- 3. Consent to operate (regulatory, ambiguous fields)
const X3 = plusDays(27);
const G3 = new Date(X3); G3.setUTCFullYear(G3.getUTCFullYear() - 5);
await build('spcb-consent-to-operate.pdf', [
  [
    { h: 'STATE POLLUTION CONTROL BOARD', big: true },
    { h: 'CONSENT TO OPERATE' },
    { t: `Consent No. SPCB/CTO/2021/08841 is hereby granted on ${long(G3)} to Acme Traders Pvt Ltd (the "Occupier") for operating its warehousing and packaging unit at Plot 22, MIDC Industrial Area, Pune, subject to the conditions below.` },
    { h: 'VALIDITY' },
    { c: '1.1', t: 'This consent shall be valid for a period of five (5) years from the date of grant.' },
    { c: '1.2', t: 'An application for renewal must be filed with the Board not less than one hundred and twenty (120) days before the consent expires. Renewal is not automatic and is at the sole discretion of the Board.' },
    { h: 'CONDITIONS OF CONSENT' },
    { c: '2.1', t: 'The Occupier shall ensure that particulate matter emissions do not exceed 150 mg/Nm3 at any stack.' },
    { c: '2.2', t: 'The Occupier shall install and maintain an online emission monitoring system and shall submit a compliance report to the Board every six (6) months.' },
    { c: '2.3', t: 'The Occupier shall pay the annual consent fee as specified in Schedule II by the last day of the first month of each consent year.' },
    { c: '2.4', t: 'The consent shall be displayed prominently at the entrance of the premises and is not transferable.' },
  ],
  [
    { h: 'COMPLIANCE AND ENFORCEMENT' },
    { c: '3.1', t: 'The Board may at any time, without prior notice, suspend, modify or revoke this consent if the Occupier fails to comply with any condition or if the Board considers it necessary in the public interest.' },
    { c: '3.2', t: 'For each day of continuing non-compliance the Occupier shall be liable to pay environmental compensation of up to INR 100,000 per day, as determined by the Board.' },
    { c: '3.3', t: 'The Occupier shall permit officers of the Board to inspect the premises at any reasonable time.' },
    { t: 'Issued by: Member Secretary, State Pollution Control Board.' },
  ],
], (R) => ({
  title: 'SPCB Consent to Operate – Pune Unit',
  contract_type: 'regulatory_class',
  vendor_name: 'State Pollution Control Board',
  doc_quality: 'Clean digital PDF. Schedule II (fee schedule) referenced but not included.',
  fields: {
    parties: F([{ name: 'State Pollution Control Board', role: 'Issuing authority' }, { name: 'Acme Traders Pvt Ltd', role: 'Occupier' }], 'high', R('Consent No.'), 'Issuer and Occupier stated in the grant paragraph.'),
    effective_date: F(iso(G3), 'high', R('Consent No.'), 'Date of grant stated.'),
    expiration_date: F(iso(X3), 'medium', R('1.1'), 'Not stated as a date; computed as date of grant + 5 years.'),
    renewal_terms: F('Not automatic. Renewal application must be filed at least 120 days before expiry and is at the Board\'s sole discretion.', 'high', R('1.2'), 'Explicit renewal clause.'),
    payment_terms: F({ amount: null, currency: null, recurrence: 'annual', due_rule: 'Annual consent fee per Schedule II, due by the last day of the first month of each consent year.' }, 'low', R('2.3'), 'Amount lives in Schedule II, which is not part of this document.'),
    termination_conditions: F('The Board may suspend, modify or revoke the consent at any time without prior notice for non-compliance or in the public interest.', 'high', R('3.1'), 'Explicit clause.'),
    service_obligations: F(['Keep particulate emissions at or below 150 mg/Nm3 at any stack', 'Maintain an online emission monitoring system', 'Submit a compliance report every 6 months', 'Display the consent at the premises entrance; not transferable', 'Allow Board officers to inspect at any reasonable time'], 'high', R('2.1', '2.2', '2.4', '3.3'), 'Listed in the conditions.'),
  },
  flags: [
    { flag_type: 'unilateral_termination', description: 'The Board can suspend or revoke the consent at any time, without notice, including on a broad "public interest" ground.', source_ref: R('3.1')[0] },
    { flag_type: 'penalty', description: 'Environmental compensation of up to INR 100,000 per day of continuing non-compliance.', source_ref: R('3.2')[0] },
    { flag_type: 'other', description: 'Renewal is not automatic and the application deadline is 120 days before expiry; check whether that deadline has already passed.', source_ref: R('1.2')[0] },
    { flag_type: 'other', description: 'The fee amount is in Schedule II, which is not attached, so the payment obligation cannot be fully verified from this document.', source_ref: R('2.3')[0] },
  ],
  summary: 'This is the State Pollution Control Board\'s permission for Acme Traders to run its Pune warehousing and packaging unit. It lasts five years from the date it was granted and does not renew automatically: you must apply at least 120 days before it ends and the Board decides. You must keep dust emissions under the stated limit, run a monitoring system, send the Board a report every six months, and pay an annual fee. The amount of that fee is in a Schedule II that is not included, so it is unknown here. The Board can cancel or suspend the permission at any time without warning, and continuing breaches can cost up to INR 100,000 a day.',
}));

// ---------------------------------------------------------------- 4. Older Nimbus order form (expired; name variant)
const E4 = plusDays(-800);
const X4 = plusDays(-435);
await build('nimbus-hosting-order-form-2024.pdf', [
  [
    { h: 'HOSTING ORDER FORM', big: true },
    { t: `This Order Form is made on ${long(E4)} between Nimbus Cloud Solutions Private Limited ("Nimbus") and Acme Traders Pvt Ltd ("Client").` },
    { c: '1.1', t: `Nimbus shall provide managed cloud hosting for Client's web storefront from ${long(E4)} until ${long(X4)}.` },
    { c: '1.2', t: 'Client shall pay a hosting fee of USD 900 per quarter, payable within thirty (30) days of invoice.' },
    { c: '1.3', t: 'This Order Form renews automatically for a further year unless Client gives sixty (60) days\' written notice of non-renewal.' },
    { c: '1.4', t: 'Either party may terminate this Order Form on ninety (90) days\' written notice.' },
    { c: '1.5', t: 'Nimbus shall provide 99.0% monthly uptime and daily backups of the storefront.' },
  ],
], (R) => ({
  title: 'Nimbus Hosting Order Form (2024)',
  contract_type: 'business_class',
  vendor_name: 'Nimbus Cloud Solutions Private Limited',
  doc_quality: 'Clean digital PDF, fully legible.',
  fields: {
    parties: F([{ name: 'Nimbus Cloud Solutions Private Limited', role: 'Provider' }, { name: 'Acme Traders Pvt Ltd', role: 'Client' }], 'high', R('This Order Form is made on'), 'Named in the preamble.'),
    effective_date: F(iso(E4), 'high', R('1.1'), 'Start date stated.'),
    expiration_date: F(iso(X4), 'high', R('1.1'), 'End date stated.'),
    renewal_terms: F('Renews automatically for another year unless the Client gives 60 days\' written notice of non-renewal.', 'high', R('1.3'), 'Explicit.'),
    payment_terms: F({ amount: 900, currency: 'USD', recurrence: 'quarterly', due_rule: 'Payable within 30 days of invoice.' }, 'high', R('1.2'), 'Explicit.'),
    termination_conditions: F('Either party may terminate on 90 days\' written notice.', 'high', R('1.4'), 'Explicit.'),
    service_obligations: F(['Managed cloud hosting for the web storefront', '99.0% monthly uptime', 'Daily backups'], 'high', R('1.1', '1.5'), 'Explicit.'),
  },
  flags: [
    { flag_type: 'auto_renewal', description: 'Renews automatically for a further year unless 60 days\' notice is given.', source_ref: R('1.3')[0] },
  ],
  summary: 'This is a hosting arrangement where Nimbus ran the Acme storefront on its cloud for about a year at USD 900 a quarter. It renews itself for another year unless Acme gives 60 days\' notice, and either side can walk away with 90 days\' notice. Nimbus promised 99% uptime and daily backups.',
}));

console.log(`\nSample PDFs in ${OUT}\nFixtures in ${FIX}`);
