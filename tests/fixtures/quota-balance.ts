/**
 * Official DeepSeek GET /user/balance fixtures for mocked unit tests.
 * These never call the network and do not read `.secrets.local.json`.
 *
 * @see https://api-docs.deepseek.com/api/get-user-balance
 */
export const DEEPSEEK_BALANCE_FIXTURES = {
  availableCny: {
    name: 'available-cny',
    queriedAt: '2026-08-17T02:30:00.000Z',
    body: {
      is_available: true,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '12.50',
          granted_balance: '2.00',
          topped_up_balance: '10.50',
        },
      ],
    },
  },
  insufficient: {
    name: 'insufficient',
    queriedAt: '2026-08-17T02:31:00.000Z',
    body: {
      is_available: false,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '0.00',
          granted_balance: '0.00',
          topped_up_balance: '0.00',
        },
      ],
    },
  },
  lowRemaining: {
    name: 'low-remaining',
    queriedAt: '2026-08-17T02:32:00.000Z',
    body: {
      is_available: true,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '1.20',
          granted_balance: '1.20',
          topped_up_balance: '0.00',
        },
      ],
    },
  },
  availableUsd: {
    name: 'available-usd',
    queriedAt: '2026-08-17T18:00:00.000Z',
    body: {
      is_available: true,
      balance_infos: [
        {
          currency: 'USD',
          total_balance: '3.00',
          granted_balance: '0.00',
          topped_up_balance: '3.00',
        },
      ],
    },
  },
} as const

