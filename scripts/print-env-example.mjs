#!/usr/bin/env node
// Regenerate the documented env template from the config spec, so the template
// can never drift from what the code actually reads.
//   node scripts/print-env-example.mjs > config/swing.env.example
import { renderEnvExample } from '../src/config/env.js';
process.stdout.write(renderEnvExample());
