# Plugin Documentation Report 插件文档报告

**Project**: OpenLearn V2  
**Module**: Plugin Subsystem (`packages/core/plugin-host/`, `packages/plugin-sdk/`)  
**Status**: Fully Verified and Documented

---

## 插件体系规范总结

1. **SDK**: `@openlearn/plugin-sdk@3.4.3`
2. **沙箱**: Worker Thread 多进程安全隔离。
3. **UI 槽位**: `teacherTab`, `classroomTool`, `studentLessonTool`, `dashboardWidget`, `helpDoc`。
4. **服务共享**: `ctx.provide()` / `ctx.resolve()` 强类型 DI 映射。
