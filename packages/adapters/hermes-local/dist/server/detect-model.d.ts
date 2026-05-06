/**
 * Detect the current model from the user's Hermes config.
 *
 * Reads ~/.hermes/config.yaml and extracts the default model
 * and provider settings.
 */
export interface DetectedModel {
    model: string;
    provider: string;
    source: "config";
}
/**
 * Read the Hermes config file and extract the default model.
 */
export declare function detectModel(configPath?: string): Promise<DetectedModel | null>;
/**
 * Parse model.default and model.provider from raw YAML content.
 * Uses simple regex parsing to avoid a YAML dependency.
 */
export declare function parseModelFromConfig(content: string): DetectedModel | null;
