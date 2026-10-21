import {defineConfig} from 'vite';
export default defineConfig({root:'apps/web',base:process.env.EULAB_ADMIN_BASE_PATH||'/',build:{outDir:'../../dist/web',emptyOutDir:true},server:{port:5173,proxy:{'/v1':{target:'http://127.0.0.1:3000',ws:true}}}});
