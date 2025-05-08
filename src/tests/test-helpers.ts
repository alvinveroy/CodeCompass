/**
 * Helper functions for tests
 */

/**
 * Set up the test environment for provider unavailability test
 */
export function setupProviderUnavailabilityTest() {
  process.env.TEST_PROVIDER_UNAVAILABLE = 'true';
  return () => {
    // Cleanup function
    delete process.env.TEST_PROVIDER_UNAVAILABLE;
  };
}

/**
 * Reset all test environment variables
 */
export function resetTestEnvironment() {
  delete process.env.TEST_PROVIDER_UNAVAILABLE;
  delete process.env.FORCE_PROVIDER_UNAVAILABLE;
  delete process.env.LLM_PROVIDER;
}
