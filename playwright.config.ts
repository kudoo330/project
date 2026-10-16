import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./test/browser',workers:1,timeout:30000,use:{baseURL:'http://127.0.0.1:8787',headless:true,launchOptions:process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH}:{}},reporter:'list'});
