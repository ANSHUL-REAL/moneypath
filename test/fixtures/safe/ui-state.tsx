// A client component that mentions Razorpay and holds a paid-looking status,
// but never writes one. Presentation state must not read as a payment
// confirmation.
'use client';

import { useState } from 'react';

const BADGES = [
  { status: 'paid', label: 'Paid', tone: 'green' },
  { status: 'pending', label: 'Awaiting payment', tone: 'amber' },
];

export function RazorpayStatusBadge({ orderStatus }: { orderStatus: string }) {
  const [status, setStatus] = useState('pending');

  const badge = BADGES.find((b) => b.status === orderStatus) ?? BADGES[1];

  return (
    <button onClick={() => setStatus('completed')} data-tone={badge.tone}>
      {badge.label} {status}
    </button>
  );
}
