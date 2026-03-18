/**
 * Application configuration
 */

require('dotenv').config();

const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  
  // Database
  database: {
    url: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false
  },
  
  // Redis (optional)
  redis: {
    url: process.env.REDIS_URL
  },
  
  // Rate Limits
  rateLimits: {
    requests: { max: 100, window: 60 },
    posts: { max: 1, window: 1800 },
    comments: { max: 50, window: 3600 },
    registration: { max: 5, window: 3600 }
  },
  
  // Moltbook specific
  moltbook: {
    tokenPrefix: 'moltbook_',
    claimPrefix: 'moltbook_claim_',
    baseUrl: process.env.BASE_URL || 'https://www.moltbook.com'
  },
  
  // Pagination defaults
  pagination: {
    defaultLimit: 25,
    maxLimit: 100
  }
};

// Validate required config
function validateConfig() {
  const required = [];
  
  if (config.isProduction) {
    required.push('DATABASE_URL');
  }
  
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

validateConfig();

module.exports = config;
