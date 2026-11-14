const usageFixture = <String, Object?>{
  'month': {
    'start': '2026-11-01T00:00:00.000Z',
    'days': 30,
    'elapsedDays': 9,
    'spentUsd': 12.5,
    'forecastUsd': 40,
    'planUsd': 3,
    'planUsage': true,
    'unpriced': true,
    'daily': [2.5, 10],
  },
  'limit': {'monthlyUsd': 25, 'reached': false},
  'taskUsd': 5,
  'entries': [
    {
      'id': 'synthetic-entry',
      'at': '2026-11-02T12:00:00.000Z',
      'title': 'Synthetic request',
      'source': 'chat',
      'costUsd': 0.25,
      'models': [
        {'provider': 'openai', 'model': 'synthetic-model', 'billing': 'api'},
      ],
      'actions': [
        {
          'label': 'Synthetic read',
          'because': {'kind': 'message', 'text': 'Synthetic instruction'},
        },
      ],
      'error': null,
    },
    {
      'id': 'synthetic-plan',
      'at': '2026-11-01T12:00:00.000Z',
      'title': 'Synthetic plan request',
      'source': 'task',
      'costUsd': null,
      'pricing': 'plan',
      'models': [
        {
          'provider': 'openai',
          'model': 'synthetic-plan-model',
          'billing': 'plan',
        },
      ],
      'actions': <Object?>[],
      'error': null,
    },
  ],
  'next': {
    'at': '2026-11-01T12:00:00.000Z',
    'id': '12345678-1234-4234-8234-123456789abc',
  },
};
