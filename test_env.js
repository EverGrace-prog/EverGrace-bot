import 'dotenv/config';

console.log('Has OPENAI_API_KEY?', !!process.env.OPENAI_API_KEY);
console.log('OPENAI_API_KEY (primi 12):', (process.env.OPENAI_API_KEY || 'MISSING').slice(0, 12));
