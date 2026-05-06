/**
 * Environment test for the Hermes Agent adapter.
 *
 * Verifies that Hermes Agent is installed, accessible, and configured
 * before allowing the adapter to be used.
 */
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@mercuryai/adapter-utils";
export declare function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;
