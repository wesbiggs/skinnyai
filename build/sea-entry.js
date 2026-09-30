// Entry point for the standalone binary (see scripts/build-sea.mjs). The
// script only runs main() itself when executed directly, so call it here.
import { main } from '../bin/skinnyai.js';

main().catch(console.error);
