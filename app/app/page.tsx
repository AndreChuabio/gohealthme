import Link from "next/link";

const steps = [
  {
    title: "The prize money shows up",
    body: "A brand or insurer puts real cash behind a real goal: sleep, steps, the works. That is the pot. You are playing for it.",
  },
  {
    title: "We confirm you are a real human",
    body: "One World ID tap. Not 400 bots in a trench coat splitting your prize. Just verified, breathing, magnificent you.",
  },
  {
    title: "You win, you get paid",
    body: "A private AI checks your result inside a sealed box. The second it says you did it, the money hits your account. No waiting room, no paperwork.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col gap-14 py-6 sm:py-12">
      <section className="text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-accent">
          the gym that pays you back
        </p>
        <h1 className="mx-auto mt-4 max-w-2xl text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
          Get paid real money for hitting health goals you were going to brag
          about anyway.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-muted">
          Sleep well, walk more, get the flu shot, finish the screening. The
          second a goal is verified, real cash lands in your wallet. A goblin
          named GAINS is watching and he is so proud it is concerning.
        </p>
        <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-muted/80">
          The cash is USDC. A robot in a sealed box checks your proof and
          physically cannot snitch your data. One World ID tap proves you are one
          real human, so no bots farm the prize.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/pools"
            className="gains-pop w-full rounded-xl bg-accent-strong px-8 py-4 text-base font-semibold text-background transition-transform hover:bg-accent active:scale-[0.98] sm:w-auto"
          >
            See what pays
          </Link>
          <Link
            href="/dashboard"
            className="w-full rounded-xl border border-edge px-8 py-4 text-base font-semibold text-foreground transition-colors hover:bg-surface-raised sm:w-auto"
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
