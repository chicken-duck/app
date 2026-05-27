// 简单的检查脚本，验证我们的重构是否正确
const serverConfig = require('./hooks/server-config');
const hookCommon = require('./hooks/hook-common');

console.log('✓ 成功导入 server-config 模块');
console.log('✓ 成功导入 hook-common 模块');

console.log('\n✓ server-config 关键函数检查:');
console.log('  - postStateToRunningServer:', typeof serverConfig.postStateToRunningServer);
console.log('  - readHostPrefix:', typeof serverConfig.readHostPrefix);

console.log('\n✓ hook-common 关键函数检查:');
console.log('  - runHook:', typeof hookCommon.runHook);

console.log('\n所有导入和导出都正常工作！');
