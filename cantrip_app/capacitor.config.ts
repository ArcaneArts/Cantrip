import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";

const config: CapacitorConfig = {
  appId: "art.cantrip",
  appName: "Cantrip",
  webDir: "dist",
  loggingBehavior: "debug",
  plugins: {
    Keyboard: {
      resize: KeyboardResize.Native,
    },
  },
  server: {
    androidScheme: "https",
    hostname: "localhost",
  },
};

export default config;
