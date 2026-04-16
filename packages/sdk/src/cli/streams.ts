export interface CliStreams {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdin?: {
    readLine: () => Promise<string>;
  };
}
