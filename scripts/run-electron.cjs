const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const isWin = process.platform === 'win32';

// Windows 下先设置控制台为 UTF-8，避免 Node 输出的中文乱码
const child = isWin
  ? spawn('cmd', ['/c', 'chcp 65001 >nul & electron .'], { stdio: 'inherit', cwd: root, shell: false })
  : spawn('electron', ['.'], { stdio: 'inherit', cwd: root });

child.on('close', (code) => process.exit(code != null ? code : 0));
