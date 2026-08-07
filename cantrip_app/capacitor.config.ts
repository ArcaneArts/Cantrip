import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "art.cantrip",
  appName: "Cantrip",
  webDir: "dist",
  loggingBehavior: "debug",
  server: {
    androidScheme: "https",
    hostname: "localhost",
  },
};

export default config;
