import { homedir } from 'node:os';
import path from 'node:path';

/** Where the MCP keeps its files. INKED_MCP_HOME overrides it (tests use this). */
export const inkedHome = () => process.env.INKED_MCP_HOME || path.join(homedir(), '.inked-mcp');
export const credentialPath = () => path.join(inkedHome(), 'credential.json');
export const configPath = () => path.join(inkedHome(), 'config.json');
export const auditPath = () => path.join(inkedHome(), 'audit.log');
