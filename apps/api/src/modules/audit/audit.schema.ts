import { z } from 'zod';

export const getDailyRootQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be formatted as YYYY-MM-DD').optional(),
});

export const getAlertProofParamsSchema = z.object({
  alertId: z.string().min(1, 'alertId is required'),
});

export const verifyProofBodySchema = z.object({
  root: z.string().regex(/^[0-9a-f]{64}$/i, 'Root must be a 64-character hex string'),
  proof: z.object({
    leafHash: z.string().regex(/^[0-9a-f]{64}$/i, 'leafHash must be a 64-character hex string'),
    path: z.array(
      z.object({
        siblingHash: z.string().regex(/^[0-9a-f]{64}$/i, 'siblingHash must be a 64-character hex string'),
        direction: z.enum(['left', 'right']),
      })
    ),
  }),
  record: z
    .object({
      id: z.string(),
      channel: z.string(),
      destination: z.string(),
      status: z.string(),
      paymentId: z.string().nullable().optional(),
      error: z.string().nullable().optional(),
      deliveredAt: z.union([z.string(), z.date()]).nullable().optional(),
      createdAt: z.union([z.string(), z.date()]),
    })
    .optional(),
});
