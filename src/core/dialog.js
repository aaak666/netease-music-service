/**
 * 桌面对话框原语：原生文件夹选择对话框（单次外部交互，无策略）
 * 服务运行在桌面会话，对话框直接弹在屏幕上；策略（单实例锁、取消语义）在调用方
 */
const { execFile } = require('child_process')
const coreError = require('./error')

const PICK_TIMEOUT = 5 * 60 * 1000 // 5 分钟无操作超时：用户离开电脑不至于把请求挂到天荒地老

/**
 * 弹出系统文件夹选择对话框，返回所选路径；用户取消返回 null
 * 编码要点：中文系统上 PowerShell 5.1 管道输出默认是控制台 OEM 代码页（cp936），
 * 而 execFile 按 utf8 解码——不含 OutputEncoding 声明时，用户选的含中文路径会变乱码，
 * 乱码路径再被当合法目录落盘激活，之后所有下载都写进乱码目录
 */
function pickFolder() {
  const script = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;'
    + 'Add-Type -AssemblyName System.Windows.Forms;'
    + '$d = New-Object System.Windows.Forms.FolderBrowserDialog;'
    + "$d.Description = '选择下载保存位置'; $d.ShowNewFolderButton = $true;"
    + 'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }'
  return new Promise((resolve, reject) => {
    // stderr 必须接住并入错误：PowerShell 报错（如 Add-Type 失败）时只看 exit code 排不了障
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeout: PICK_TIMEOUT, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) return reject(new Error('选择超时（5 分钟未操作，已取消）'))
        if (err.code === 'ENOENT') {
          const e = new Error('未找到 PowerShell，无法弹出文件夹选择对话框')
          e.noPowerShell = true
          return reject(e)
        }
        return reject(new Error('无法打开文件夹选择对话框: ' + coreError.errMsg(err) + (stderr ? ` :: ${String(stderr).trim()}` : '')))
      }
      const p = String(stdout || '').trim()
      resolve(p || null) // 空输出 = 用户点了取消
    })
  })
}

module.exports = { pickFolder, PICK_TIMEOUT }
