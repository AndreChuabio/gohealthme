import Link from "next/link";

const steps = [
  {
    title: "Sponsors fund pools",
    body: "Brands and insurers stake USDC bounties on Arc behind concrete health goals: sleep streaks, workouts, daily movement.",
  },
  {
    title: "Verified humans join",
    body: "One World ID proof per pool. No bots, no duplicate entries, no sybil farming the bounty.",
  },
  {
    title: "Hit the goal, get paid instantly",
    body: "A privacy-preserving oracle verifies outcomes from wearable data. The moment you achieve, USDC lands in your wallet.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col gap-14 py-6 sm:py-12">
      <section className="text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-accent">
          Health goals with real stakes
        </p>
        <h1 className="mx-auto mt-4 max-w-2xl text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
          Get paid in USDC the moment you hit a verified health goal
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-muted">
          Sponsor-funded bounty pools on Arc. World ID keeps them human-only.
          Your health data stays private; only verified outcomes go on-chain.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/pools"
            className="w-full rounded-xl bg-accent-strong px-8 py-4 text-base font-semibold text-background hover:bg-accent sm:w-auto"
          >
            Browse pools
          </Link>
          <Link
            href="/dashboard"
            className="w-full rounded-xl border border-edge px-8 py-4 text-base font-semibold text-foreground hover:bg-surface-raised sm:w-auto"
          >
            My goals
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {steps.map((step, i) => (
          <div
            key={step.title}
            className="rounded-2xl border border-edge bg-surface p-6"
          >
            <p className="font-mono text-sm font-bold text-accent">
              0{i + 1}
            </p>
            <h2 className="mt-2 text-lg font-semibold">{step.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {step.body}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}
