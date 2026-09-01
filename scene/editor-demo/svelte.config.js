import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// There is not one .svelte file in this package — the editor's are, and they are compiled from source
// here, so this project needs the same preprocessor the editor's own does.
export default { preprocess: vitePreprocess() };
