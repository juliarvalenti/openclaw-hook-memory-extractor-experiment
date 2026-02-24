export interface ExperimentConfig {
  name: string;
  description: string;
  seed?: string;
  acceptance_criteria?: string[];
  notes?: string;
}

// ── Docker Compose types (subset we actually use) ──────────────────────────

export interface ComposeHealthcheck {
  test: string[];
  interval: string;
  timeout: string;
  retries: number;
  start_period: string;
}

export interface ComposeBuild {
  context: string;
  dockerfile: string;
}

export interface ComposeService {
  image?: string;
  build?: ComposeBuild;
  environment?: Record<string, string>;
  volumes?: string[];
  ports?: string[];
  networks?: string[];
  depends_on?: Record<string, { condition: string }>;
  command?: string[];
  restart?: string;
  healthcheck?: ComposeHealthcheck;
}

export interface ComposeNetwork {
  driver?: string;
  external?: boolean;
  name?: string;
}

export interface ComposeFile {
  // Leading comment — js-yaml doesn't support comments, so we prepend manually.
  services: Record<string, ComposeService>;
  networks: Record<string, ComposeNetwork>;
}
