module.exports = {
  apps: [
    {
      name: 'api-gateway',
      script: 'apps/api-gateway/dist/index.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'ride-service',
      script: 'apps/ride-service/dist/index.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'wallet-service',
      script: 'apps/wallet-service/dist/index.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'payment-service',
      script: 'apps/payment-service/dist/index.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'notification-worker',
      script: 'apps/notification-worker/dist/index.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'whatsapp-gateway',
      script: 'apps/whatsapp-gateway/dist/index.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'group-ride',
      script: 'apps/group-ride/dist/index.js',
      env: { NODE_ENV: 'production' },
    },
  ],
};
