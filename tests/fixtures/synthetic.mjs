#!/usr/bin/env node
// Builds a synthetic multi-language project with a two-commit history, so the
// diff HEAD~1..HEAD is a realistic feature change: an orders schema migration,
// a TS service and a PHP controller that follow from it, a test and a doc.
//
//   node tests/fixtures/synthetic.mjs <target-dir>
//
// No network, ~1s. Deliberately covers TS + PHP + SQL + MD so the viewer's
// scope tags, language dots and the er-diff requirement all get exercised.

import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

const dir = resolve(process.argv[2] || '.fixtures/synthetic')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'ignore', 'inherit'] })
const put = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s) }

// ── commit 1: the project before the change ──────────────────────────────────
put('README.md', '# acme-shop\n\nA small storefront: PHP API in front, TypeScript workers behind.\n')
put('db/migrations/0001_init.sql', `CREATE TABLE customers (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers (id),
  total_cents  INTEGER NOT NULL,
  status       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`)
put('api/src/Controller/OrdersController.php', `<?php

namespace Acme\\Controller;

final class OrdersController
{
    public function __construct(private readonly OrderRepository $orders) {}

    public function place(Request $req): Response
    {
        $order = $this->orders->create($req->customerId(), $req->lines());

        return Response::json(['id' => $order->id, 'status' => $order->status]);
    }
}
`)
put('api/src/Repository/OrderRepository.php', `<?php

namespace Acme\\Repository;

final class OrderRepository
{
    public function create(int $customerId, array $lines): Order
    {
        $total = array_sum(array_map(fn ($l) => $l->cents, $lines));

        return $this->insert([
            'customer_id' => $customerId,
            'total_cents' => $total,
            'status' => 'placed',
        ]);
    }
}
`)
put('worker/src/fulfilment.ts', `import { db } from './db'

export async function fulfil(orderId: number): Promise<void> {
  const order = await db.order(orderId)
  if (order.status !== 'placed') return
  await ship(order)
  await db.setStatus(orderId, 'shipped')
}
`)
put('worker/src/db.ts', "export const db = { order: async (id: number) => ({ id, status: 'placed' }), setStatus: async () => {} }\n")
put('worker/test/fulfilment.test.ts', `import { fulfil } from '../src/fulfilment'

test('fulfil ships a placed order', async () => {
  await fulfil(1)
})
`)

git('init', '--quiet', '--initial-branch=main')
git('config', 'user.email', 'fixture@example.com')
git('config', 'user.name', 'Fixture')
git('add', '-A')
git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'acme-shop: orders, fulfilment worker')

// ── commit 2: the change under review ────────────────────────────────────────
// Refunds: a schema migration, the API path that writes it, the worker path
// that reads it, a test, and a decision record — one causal chain per layer.
put('docs/refunds.md', `# Refunds — scope decisions

- A refund is a **row**, not a status: an order can be refunded twice (partial
  refunds), so \`orders.status\` cannot carry it.
- Money never changes on the order: \`total_cents\` stays the charged amount,
  \`refunds.cents\` accumulates. Reporting subtracts.
- Refunds are only allowed after fulfilment, so the worker — not the API — is
  the component that can reject one.
- Provider calls are out of scope for this change: we record the intent and let
  the payout job pick it up.
`)
put('db/migrations/0002_refunds.sql', `CREATE TABLE refunds (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT NOT NULL REFERENCES orders (id),
  cents        INTEGER NOT NULL CHECK (cents > 0),
  reason       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX refunds_order_id_idx ON refunds (order_id);

-- Denormalized for the orders list, kept in sync by the worker.
ALTER TABLE orders ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders DROP COLUMN status;
ALTER TABLE orders ADD COLUMN state TEXT NOT NULL DEFAULT 'placed';
`)
put('api/src/Controller/OrdersController.php', `<?php

namespace Acme\\Controller;

final class OrdersController
{
    public function __construct(
        private readonly OrderRepository $orders,
        private readonly RefundRepository $refunds,
    ) {}

    public function place(Request $req): Response
    {
        $order = $this->orders->create($req->customerId(), $req->lines());

        return Response::json(['id' => $order->id, 'state' => $order->state]);
    }

    public function refund(Request $req): Response
    {
        $order = $this->orders->find($req->orderId());

        // Only fulfilled orders can be refunded — see docs/refunds.md.
        if ($order->state !== 'shipped') {
            return Response::json(['code' => 'NOT_FULFILLED'], 409);
        }

        $refund = $this->refunds->record($order->id, $req->cents(), $req->reason());

        return Response::json(['refund_id' => $refund->id, 'refunded_cents' => $refund->orderTotal], 201);
    }
}
`)
put('api/src/Repository/RefundRepository.php', `<?php

namespace Acme\\Repository;

final class RefundRepository
{
    /** Records the refund and bumps the denormalized order counter in one transaction. */
    public function record(int $orderId, int $cents, string $reason): Refund
    {
        return $this->tx(function () use ($orderId, $cents, $reason) {
            $refund = $this->insert(['order_id' => $orderId, 'cents' => $cents, 'reason' => $reason]);
            $this->exec('UPDATE orders SET refunded_cents = refunded_cents + ? WHERE id = ?', [$cents, $orderId]);

            return $refund;
        });
    }
}
`)
put('api/src/Repository/OrderRepository.php', `<?php

namespace Acme\\Repository;

final class OrderRepository
{
    public function create(int $customerId, array $lines): Order
    {
        $total = array_sum(array_map(fn ($l) => $l->cents, $lines));

        return $this->insert([
            'customer_id' => $customerId,
            'total_cents' => $total,
            'state' => 'placed',
        ]);
    }

    public function find(int $id): Order
    {
        return $this->one('SELECT id, total_cents, refunded_cents, state FROM orders WHERE id = ?', [$id]);
    }
}
`)
put('worker/src/fulfilment.ts', `import { db } from './db'
import { settleRefunds } from './refunds'

export async function fulfil(orderId: number): Promise<void> {
  const order = await db.order(orderId)
  // 'status' became 'state' in migration 0002 — the old value is gone.
  if (order.state !== 'placed') return
  await ship(order)
  await db.setState(orderId, 'shipped')
  await settleRefunds(orderId)
}
`)
put('worker/src/refunds.ts', `import { db } from './db'

/** Pays out refunds recorded by the API; safe to run twice. */
export async function settleRefunds(orderId: number): Promise<number> {
  const pending = await db.pendingRefunds(orderId)
  let paid = 0
  for (const refund of pending) {
    await payout(refund)
    await db.markSettled(refund.id)
    paid += refund.cents
  }
  return paid
}
`)
put('worker/src/db.ts', `export const db = {
  order: async (id: number) => ({ id, state: 'placed', totalCents: 0, refundedCents: 0 }),
  setState: async () => {},
  pendingRefunds: async () => [],
  markSettled: async () => {},
}
`)
put('worker/test/refunds.test.ts', `import { settleRefunds } from '../src/refunds'

test('settleRefunds pays each pending refund exactly once', async () => {
  expect(await settleRefunds(1)).toBe(0)
})

test('settleRefunds is idempotent', async () => {
  await settleRefunds(1)
  expect(await settleRefunds(1)).toBe(0)
})
`)
put('.env.example', `DATABASE_URL=postgres://localhost/acme
REFUND_PAYOUT_QUEUE=refunds
REFUND_MAX_CENTS=50000
`)

git('add', '-A')
git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'refunds: record as rows, rename order status to state')
console.log(`synthetic fixture built at ${dir} (diff = HEAD~1..HEAD)`)
