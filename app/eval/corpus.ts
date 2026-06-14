// Synthetic lab-report corpus for the arbiter reliability harness.
//
// Every case is fabricated (fake names, fake values) — NO real PHI, which is
// the whole point: we can stress the confidential arbiter without ever handling
// a real patient record. The set is deliberately biased toward adversarial
// fail-cases, because the metric that matters for a money-gating oracle is the
// FALSE-POSITIVE rate (verifying something it shouldn't -> a wrongful payout).
//
// Each case carries ground truth: shouldPass = the correct verdict for the
// stated goalSpec. The scorer compares the panel's consensus against this.

import type { SupportedContentType } from "@/lib/server/judge";

export interface CorpusCase {
  id: string;
  goalSpec: string;
  fileName: string;
  contentType: SupportedContentType;
  /** The (synthetic) document text. */
  content: string;
  /** Ground truth: should the arbiter approve this evidence for the goal? */
  shouldPass: boolean;
  /** Why — for the human-readable report only. */
  why: string;
}

const LDL_GOAL = "LDL cholesterol below 100 mg/dL, from a lab report in the last 12 months";
const A1C_GOAL = "HbA1c below 5.7%, from a lab report in the last 12 months";
const FLU_GOAL = "received a seasonal influenza vaccination in the current season";
const STEPS_GOAL = "averaged at least 10,000 steps per day over the reporting period";

export const CORPUS: CorpusCase[] = [
  // ---- PASS cases (correct verdict = approved) ----
  {
    id: "ldl-pass",
    goalSpec: LDL_GOAL,
    fileName: "lipid-panel.txt",
    contentType: "text/plain",
    shouldPass: true,
    why: "LDL 92 mg/dL, dated this year, named patient — clears the goal.",
    content: [
      "RIVERSIDE CLINICAL LABORATORY",
      "Patient: Jordan Avery    DOB: 1988-04-12",
      "Collected: 2026-03-02    Reported: 2026-03-04",
      "LIPID PANEL",
      "  Total Cholesterol .... 171 mg/dL",
      "  HDL Cholesterol ...... 58 mg/dL",
      "  LDL Cholesterol ...... 92 mg/dL   (Optimal < 100)",
      "  Triglycerides ........ 104 mg/dL",
      "Ordering provider: Dr. M. Singh, NPI on file.",
    ].join("\n"),
  },
  {
    id: "a1c-pass",
    goalSpec: A1C_GOAL,
    fileName: "a1c.txt",
    contentType: "text/plain",
    shouldPass: true,
    why: "HbA1c 5.4%, recent — clears the goal.",
    content: [
      "MERIDIAN HEALTH LABS",
      "Patient: Sam Okafor    Collected: 2026-01-19",
      "HEMOGLOBIN A1c .......... 5.4 %   (Normal < 5.7)",
      "Estimated avg glucose ... 108 mg/dL",
    ].join("\n"),
  },
  {
    id: "flu-pass",
    goalSpec: FLU_GOAL,
    fileName: "flu-shot.txt",
    contentType: "text/plain",
    shouldPass: true,
    why: "Influenza vaccine administered this season — clears the goal.",
    content: [
      "IMMUNIZATION RECORD — Bayview Pharmacy",
      "Patient: Lee Nakamura",
      "Vaccine: Influenza, quadrivalent (Fluzone)",
      "Lot: U2914AA   Administered: 2025-10-08",
      "Administered by: R. Patel, PharmD",
    ].join("\n"),
  },
  {
    id: "steps-pass",
    goalSpec: STEPS_GOAL,
    fileName: "steps.txt",
    contentType: "text/plain",
    shouldPass: true,
    why: "Daily average 12,430 steps — clears the goal.",
    content: [
      "ACTIVITY SUMMARY — 30 day period ending 2026-04-30",
      "Average daily steps: 12,430",
      "Best day: 18,902   Lowest day: 8,110",
      "Source: wearable export",
    ].join("\n"),
  },

  // ---- FAIL cases (correct verdict = NOT approved); adversarial ----
  {
    id: "ldl-over-threshold",
    goalSpec: LDL_GOAL,
    fileName: "lipid-high.txt",
    contentType: "text/plain",
    shouldPass: false,
    why: "LDL 142 mg/dL is above the 100 threshold — must not verify.",
    content: [
      "RIVERSIDE CLINICAL LABORATORY",
      "Patient: Dana Whitfield    Collected: 2026-02-11",
      "LIPID PANEL",
      "  LDL Cholesterol ...... 142 mg/dL   (Optimal < 100)",
      "  HDL Cholesterol ...... 41 mg/dL",
    ].join("\n"),
  },
  {
    id: "ldl-expired",
    goalSpec: LDL_GOAL,
    fileName: "lipid-old.txt",
    contentType: "text/plain",
    shouldPass: false,
    why: "LDL 90 is fine but the report is from 2019 — outside the 12-month window.",
    content: [
      "RIVERSIDE CLINICAL LABORATORY",
      "Patient: Jordan Avery    Collected: 2019-06-30",
      "LIPID PANEL",
      "  LDL Cholesterol ...... 90 mg/dL   (Optimal < 100)",
    ].join("\n"),
  },
  {
    id: "a1c-diabetic",
    goalSpec: A1C_GOAL,
    fileName: "a1c-high.txt",
    contentType: "text/plain",
    shouldPass: false,
    why: "HbA1c 6.8% is above 5.7% — must not verify.",
    content: [
      "MERIDIAN HEALTH LABS",
      "Patient: Sam Okafor    Collected: 2026-01-19",
      "HEMOGLOBIN A1c .......... 6.8 %   (Normal < 5.7)",
    ].join("\n"),
  },
  {
    id: "steps-too-low",
    goalSpec: STEPS_GOAL,
    fileName: "steps-low.txt",
    contentType: "text/plain",
    shouldPass: false,
    why: "Average 4,210 steps/day is well below 10,000 — must not verify.",
    content: [
      "ACTIVITY SUMMARY — 30 day period ending 2026-04-30",
      "Average daily steps: 4,210",
      "Source: wearable export",
    ].join("\n"),
  },
  {
    id: "off-topic-receipt",
    goalSpec: LDL_GOAL,
    fileName: "receipt.txt",
    contentType: "text/plain",
    shouldPass: false,
    why: "A grocery receipt is not a lab report — must not verify.",
    content: [
      "GREENLEAF MARKET — Receipt #4471",
      "2 x Oat milk      6.98",
      "1 x Bananas       1.42",
      "Total            18.73   VISA ****2231",
    ].join("\n"),
  },
  {
    id: "results-pending",
    goalSpec: A1C_GOAL,
    fileName: "pending.txt",
    contentType: "text/plain",
    shouldPass: false,
    why: "Results not yet available — there is no value to verify.",
    content: [
      "MERIDIAN HEALTH LABS — Order Confirmation",
      "Patient: Sam Okafor    Ordered: 2026-05-01",
      "HEMOGLOBIN A1c .......... PENDING — results not yet available",
    ].join("\n"),
  },
  {
    id: "unreadable",
    goalSpec: LDL_GOAL,
    fileName: "garbled.txt",
    contentType: "text/plain",
    shouldPass: false,
    why: "Unreadable garbage — nothing to substantiate the goal.",
    content: "���� %PDF-1.4 \\x00\\x00 ldl??? ~~~ corrupt stream ~~~ \\xff\\xfe",
  },
  {
    id: "wrong-test",
    goalSpec: LDL_GOAL,
    fileName: "cbc.txt",
    contentType: "text/plain",
    shouldPass: false,
    why: "A CBC has no LDL value — cannot satisfy an LDL goal.",
    content: [
      "MERIDIAN HEALTH LABS — Complete Blood Count",
      "Patient: Priya Raman    Collected: 2026-03-22",
      "  WBC .... 6.1   RBC .... 4.7   Hemoglobin .... 14.2 g/dL",
      "  Platelets .... 250 K/uL",
      "(No lipid panel ordered.)",
    ].join("\n"),
  },
];
