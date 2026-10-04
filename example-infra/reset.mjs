#!/usr/bin/env node
// Restores the fake service to the state in seed-state.json.

import { reset, stateDir } from './state.mjs';

reset();
console.log(`infractl state reset (${stateDir()})`);
