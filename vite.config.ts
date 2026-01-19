import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { transformSync, buildSync } from 'esbuild';
import glob from 'glob';
import { generateIcons } from './scripts/generate-icons';
import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';

// 检查是否构建特定脚本
const scriptToBuild = process.env.SCRIPT;
// 检查是否为生产环境构建（不包含测试代码和彩蛋）
const isProductionBuild = process.env.BUILD_TARGET === 'production';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: scriptToBuild ? false : true, // 只有完整构建时清空目录
    rollupOptions: scriptToBuild ? getSingleScriptConfig(scriptToBuild) : getAllScriptsConfig(),
    // Generate source maps for development
    sourcemap: process.env.NODE_ENV === 'development',
    // Minify for production
    minify: process.env.NODE_ENV === 'production',
    target: 'es2020'
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@assets': resolve(__dirname, 'src/assets')
    }
  },
  define: {
    // Define environment variables
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
    'process.env.BUILD_TARGET': JSON.stringify(process.env.BUILD_TARGET || 'development')
  },
  plugins: [
    // Custom plugin to handle extension-specific tasks
    {
      name: 'chrome-extension-builder',
      buildStart() {
        console.log(`🚀 Building Chrome Extension${isProductionBuild ? ' (Production)' : ''}...`);
        // 生产环境构建不需要清理测试文件
        if (!isProductionBuild) {
          // Cleanup old test artifacts in public/test to avoid stale runner.js/ts conflicts
          try {
            const testDir = resolve(__dirname, 'public', 'test');
            if (existsSync(testDir)) {
              const walk = (dir: string) => {
                const entries = readdirSync(dir);
                for (const entry of entries) {
                  const full = resolve(dir, entry);
                  const stats = statSync(full);
                  if (stats.isDirectory()) {
                    walk(full);
                  } else if (full.endsWith('.ts') || /runner\.js$/.test(full)) {
                    unlinkSync(full);
                  }
                }
              };
              walk(testDir);
              console.log('🧹 Cleaned stale .ts and runner.js from public/test');
            }
          } catch (err) {
            console.warn('Cleanup public/test failed:', (err as Error).message);
          }
        }
      },
      async buildEnd() {
        // 只有完整构建时才生成图标
        if (!scriptToBuild) {
          try {
            console.log('📦 Generating icons...');
            await generateIcons();
            console.log('✅ Icons generated successfully');
          } catch (error) {
            console.error('❌ Error generating icons:', error);
          }
        }
      },
      generateBundle(options, bundle) {
        // 只有完整构建时才复制资源文件
        if (!scriptToBuild) {
          // Copy manifest.json to dist
          try {
            const manifestContent = readFileSync('./manifest.json', 'utf-8');
            this.emitFile({
              type: 'asset',
              fileName: 'manifest.json',
              source: manifestContent
            });
          } catch (error) {
            console.warn('Warning: Could not copy manifest.json:', error.message);
          }

          // Copy locales
          const locales = ['en', 'zh'];
          locales.forEach((locale) => {
            try {
              const messagesContent = readFileSync(`./_locales/${locale}/messages.json`, 'utf-8');
              this.emitFile({
                type: 'asset',
                fileName: `_locales/${locale}/messages.json`,
                source: messagesContent
              });
            } catch (error) {
              console.warn(`Warning: Could not copy locale ${locale}:`, error.message);
            }
          });

          // No HTML files to copy for new architecture

          // 生产环境构建：不包含测试资源和测试运行器
          if (!isProductionBuild) {
            // Copy all test assets (html/css/js/json/md/ts) - only for development builds
            try {
              const testFiles = glob.sync('./test/**/*.{html,css,js,json,md,ts}', { nodir: true });
              testFiles.forEach((file) => {
                try {
                  // Skip .js file if corresponding .ts exists to avoid stale overrides
                  if (file.endsWith('.js')) {
                    const tsSibling = file.slice(0, -3) + '.ts';
                    if (testFiles.includes(tsSibling)) {
                      return; // ignore js sibling
                    }
                  }
                  const source = readFileSync(file, 'utf-8');
                  if (file.endsWith('.ts')) {
                    let code: string;
                    if (file.endsWith('runner.ts')) {
                      // Bundle runner.ts to include its dependencies (e.g., diff)
                      const bundle = buildSync({
                        entryPoints: [file],
                        bundle: true,
                        platform: 'browser',
                        format: 'esm',
                        target: 'es2020',
                        write: false
                      });
                      code = bundle.outputFiles[0].text;
                    } else {
                      const result = transformSync(source, {
                        loader: 'ts',
                        format: 'esm',
                        target: 'es2020',
                        sourcemap: false
                      });
                      code = result.code;
                    }
                    const jsFileName = file.replace('./', '').replace(/\.ts$/, '.js');
                    this.emitFile({ type: 'asset', fileName: jsFileName, source: code });
                  } else {
                    this.emitFile({ type: 'asset', fileName: file.replace('./', ''), source });
                  }
                } catch (error) {
                  console.warn('Warning: Could not copy/compile test asset', file, ':', (error as Error).message);
                }
              });
            } catch (error) {
              console.warn('Warning: Failed to glob test assets:', (error as Error).message);
            }
          }
        }
      }
    }
  ],
  // Optimize dependencies
  optimizeDeps: {
    include: ['uuid']
  },
  // Development server (not used for extension, but useful for testing components)
  server: {
    port: 3000,
    open: false
  }
});

// 单个脚本构建配置
function getSingleScriptConfig(script: string) {
  const configs: Record<string, any> = {
    'wechat-content': {
      input: resolve(__dirname, 'src/content/wechat-content.ts'),
      output: {
        format: 'iife',
        name: 'WeChatContent',
        dir: 'dist',
        entryFileNames: 'src/content/wechat-content.js',
        inlineDynamicImports: true
      }
    },
    'csdn-publisher': {
      input: resolve(__dirname, 'src/content/csdn-publisher.ts'),
      output: {
        format: 'iife',
        name: 'CsdnPublisher',
        dir: 'dist',
        entryFileNames: 'src/content/csdn-publisher.js',
        inlineDynamicImports: true
      }
    },
    'tencent-cloud-dev-publisher': {
      input: resolve(__dirname, 'src/content/tencent-cloud-dev-publisher.ts'),
      output: {
        format: 'iife',
        name: 'TencentCloudDevPublisher',
        dir: 'dist',
        entryFileNames: 'src/content/tencent-cloud-dev-publisher.js',
        inlineDynamicImports: true
      }
    },
    'cnblogs-publisher': {
      input: resolve(__dirname, 'src/content/cnblogs-publisher.ts'),
      output: {
        format: 'iife',
        name: 'CnblogsPublisher',
        dir: 'dist',
        entryFileNames: 'src/content/cnblogs-publisher.js',
        inlineDynamicImports: true
      }
    },
    'oschina-publisher': {
      input: resolve(__dirname, 'src/content/oschina-publisher.ts'),
      output: {
        format: 'iife',
        name: 'OschinaPublisher',
        dir: 'dist',
        entryFileNames: 'src/content/oschina-publisher.js',
        inlineDynamicImports: true
      }
    },
    'woshipm-publisher': {
      input: resolve(__dirname, 'src/content/woshipm-publisher.ts'),
      output: {
        format: 'iife',
        name: 'WoshipmPublisher',
        dir: 'dist',
        entryFileNames: 'src/content/woshipm-publisher.js',
        inlineDynamicImports: true
      }
    },
    'mowen-publisher': {
      input: resolve(__dirname, 'src/content/mowen-publisher.ts'),
      output: {
        format: 'iife',
        name: 'MowenPublisher',
        dir: 'dist',
        entryFileNames: 'src/content/mowen-publisher.js',
        inlineDynamicImports: true
      }
    },
    'sspai-publisher': {
      input: resolve(__dirname, 'src/content/sspai-publisher.ts'),
      output: {
        format: 'iife',
        name: 'SspaiPublisher',
        dir: 'dist',
        entryFileNames: 'src/content/sspai-publisher.js',
        inlineDynamicImports: true
      }
    },
    'baijiahao-publisher': {
      input: resolve(__dirname, 'src/content/baijiahao-publisher.ts'),
      output: {
        format: 'iife',
        name: 'BaijiahaoPublisher',
        dir: 'dist',
        entryFileNames: 'src/content/baijiahao-publisher.js',
        inlineDynamicImports: true
      }
    },
    'toutiao-publisher': {
      input: resolve(__dirname, 'src/content/toutiao-publisher.ts'),
      output: {
        format: 'iife',
        name: 'ToutiaoPublisher',
        dir: 'dist',
        entryFileNames: 'src/content/toutiao-publisher.js',
        inlineDynamicImports: true
      }
    },
    'feishu-docs-publisher': {
      input: resolve(__dirname, 'src/content/feishu-docs-publisher.ts'),
      output: {
        format: 'iife',
        name: 'FeishuDocsPublisher',
        dir: 'dist',
        entryFileNames: 'src/content/feishu-docs-publisher.js',
        inlineDynamicImports: true
      }
    },
    background: {
      input: resolve(__dirname, 'src/background.ts'),
      output: {
        format: 'umd',
        name: 'BaweiBackground',
        dir: 'dist',
        entryFileNames: 'src/background.js',
        inlineDynamicImports: true
      }
    }
  };

  return configs[script] || configs['wechat-content'];
}

// 所有脚本构建配置（使用内联配置避免 chunks）
function getAllScriptsConfig() {
  return {
    input: {
      'wechat-content': resolve(__dirname, 'src/content/wechat-content.ts'),
      'csdn-publisher': resolve(__dirname, 'src/content/csdn-publisher.ts'),
      'tencent-cloud-dev-publisher': resolve(__dirname, 'src/content/tencent-cloud-dev-publisher.ts'),
      'cnblogs-publisher': resolve(__dirname, 'src/content/cnblogs-publisher.ts'),
      'oschina-publisher': resolve(__dirname, 'src/content/oschina-publisher.ts'),
      'woshipm-publisher': resolve(__dirname, 'src/content/woshipm-publisher.ts'),
      'mowen-publisher': resolve(__dirname, 'src/content/mowen-publisher.ts'),
      'sspai-publisher': resolve(__dirname, 'src/content/sspai-publisher.ts'),
      'baijiahao-publisher': resolve(__dirname, 'src/content/baijiahao-publisher.ts'),
      'toutiao-publisher': resolve(__dirname, 'src/content/toutiao-publisher.ts'),
      'feishu-docs-publisher': resolve(__dirname, 'src/content/feishu-docs-publisher.ts'),
      background: resolve(__dirname, 'src/background.ts')
    },
    output: {
      format: 'es',
      entryFileNames: (chunkInfo) => {
        const name = chunkInfo.name;
        if (name === 'wechat-content') return 'src/content/wechat-content.js';
        if (name === 'csdn-publisher') return 'src/content/csdn-publisher.js';
        if (name === 'tencent-cloud-dev-publisher') return 'src/content/tencent-cloud-dev-publisher.js';
        if (name === 'cnblogs-publisher') return 'src/content/cnblogs-publisher.js';
        if (name === 'oschina-publisher') return 'src/content/oschina-publisher.js';
        if (name === 'woshipm-publisher') return 'src/content/woshipm-publisher.js';
        if (name === 'mowen-publisher') return 'src/content/mowen-publisher.js';
        if (name === 'sspai-publisher') return 'src/content/sspai-publisher.js';
        if (name === 'baijiahao-publisher') return 'src/content/baijiahao-publisher.js';
        if (name === 'toutiao-publisher') return 'src/content/toutiao-publisher.js';
        if (name === 'feishu-docs-publisher') return 'src/content/feishu-docs-publisher.js';
        if (name === 'background') return 'src/background.js';
        return '[name].js';
      },
      manualChunks: undefined, // 禁用手动分块
      chunkFileNames: 'chunks/[name]-[hash].js'
    },
    external: [] // 确保所有依赖都被打包
  };
}

