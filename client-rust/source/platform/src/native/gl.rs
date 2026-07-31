//! Native OpenGL bindings, constants, and safe FFI wrappers.
#![allow(non_snake_case, dead_code)]

use std::os::raw::c_void;

// Constants
pub const COLOR_BUFFER_BIT: u32 = 0x00004000;
pub const DEPTH_BUFFER_BIT: u32 = 0x00000100;
pub const DEPTH_TEST: u32 = 0x0B71;
pub const CULL_FACE: u32 = 0x0B44;
pub const BACK: u32 = 0x0405;
pub const FRONT: u32 = 0x0404;
pub const BLEND: u32 = 0x0BE2;
pub const SRC_ALPHA: u32 = 0x0302;
pub const ONE_MINUS_SRC_ALPHA: u32 = 0x0303;
pub const ONE: u32 = 1;

pub const VERTEX_SHADER: u32 = 0x8B31;
pub const FRAGMENT_SHADER: u32 = 0x8B30;
pub const COMPILE_STATUS: u32 = 0x8B81;
pub const LINK_STATUS: u32 = 0x8B82;
pub const INFO_LOG_LENGTH: u32 = 0x8B84;

pub const TEXTURE_2D: u32 = 0x0DE1;
pub const TEXTURE0: u32 = 0x84C0;
pub const TEXTURE_MIN_FILTER: u32 = 0x2801;
pub const TEXTURE_MAG_FILTER: u32 = 0x2800;
pub const TEXTURE_WRAP_S: u32 = 0x2802;
pub const TEXTURE_WRAP_T: u32 = 0x2803;

pub const NEAREST: i32 = 0x2600;
pub const LINEAR: i32 = 0x2601;
pub const CLAMP_TO_EDGE: i32 = 0x812F;
pub const REPEAT: i32 = 0x2901;

pub const RGBA: u32 = 0x1908;
pub const RGBA8: u32 = 0x8058;
pub const SRGB8_ALPHA8: u32 = 0x8C43;
pub const RED: u32 = 0x1903;
pub const RG: u32 = 0x8227;
pub const R8: u32 = 0x8229;
pub const RG8: u32 = 0x822B;
pub const DEPTH_COMPONENT: u32 = 0x1902;
pub const DEPTH_COMPONENT24: u32 = 0x81A6;

pub const UNSIGNED_BYTE: u32 = 0x1401;
pub const UNSIGNED_SHORT: u32 = 0x1403;
pub const UNSIGNED_INT: u32 = 0x1405;
pub const FLOAT: u32 = 0x1406;

pub const ARRAY_BUFFER: u32 = 0x8892;
pub const ELEMENT_ARRAY_BUFFER: u32 = 0x8893;
pub const STATIC_DRAW: u32 = 0x88E4;
pub const DYNAMIC_DRAW: u32 = 0x88E8;

pub const TRIANGLES: u32 = 0x0004;

pub const FRAMEBUFFER: u32 = 0x8D40;
pub const COLOR_ATTACHMENT0: u32 = 0x8CE0;
pub const DEPTH_ATTACHMENT: u32 = 0x8D00;
pub const FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
pub const UNPACK_ALIGNMENT: u32 = 0x0CF5;
pub const TEXTURE_3D: u32 = 0x806F;
pub const TEXTURE_WRAP_R: u32 = 0x8072;
pub const RGBA16F: u32 = 0x881A;
pub const HALF_FLOAT: u32 = 0x140B;
pub const COLOR_ATTACHMENT1: u32 = 0x8CE1;
pub const COLOR_ATTACHMENT2: u32 = 0x8CE2;
pub const COLOR_ATTACHMENT3: u32 = 0x8CE3;
pub const MAX_COLOR_ATTACHMENTS: u32 = 0x8CDF;
pub const MAX_DRAW_BUFFERS: u32 = 0x8824;
pub const LINEAR_MIPMAP_LINEAR: i32 = 0x2703;
pub const NEAREST_MIPMAP_NEAREST: i32 = 0x2700;

extern "C" {
    fn glClearColor(red: f32, green: f32, blue: f32, alpha: f32);
    fn glClear(mask: u32);
    fn glViewport(x: i32, y: i32, width: i32, height: i32);
    fn glEnable(cap: u32);
    fn glDisable(cap: u32);
    fn glCullFace(mode: u32);
    fn glDepthMask(flag: u8);
    fn glColorMask(red: u8, green: u8, blue: u8, alpha: u8);
    fn glBlendFunc(sfactor: u32, dfactor: u32);
    fn glGetIntegerv(pname: u32, data: *mut i32);

    fn glCreateShader(type_: u32) -> u32;
    fn glShaderSource(shader: u32, count: i32, string: *const *const u8, length: *const i32);
    fn glCompileShader(shader: u32);
    fn glGetShaderiv(shader: u32, pname: u32, params: *mut i32);
    fn glGetShaderInfoLog(shader: u32, bufSize: i32, length: *mut i32, infoLog: *mut u8);
    fn glDeleteShader(shader: u32);

    fn glCreateProgram() -> u32;
    fn glAttachShader(program: u32, shader: u32);
    fn glLinkProgram(program: u32);
    fn glGetProgramiv(program: u32, pname: u32, params: *mut i32);
    fn glGetProgramInfoLog(program: u32, bufSize: i32, length: *mut i32, infoLog: *mut u8);
    fn glUseProgram(program: u32);
    fn glDeleteProgram(program: u32);

    fn glGetUniformLocation(program: u32, name: *const u8) -> i32;
    fn glUniform1i(location: i32, v0: i32);
    fn glUniform1f(location: i32, v0: f32);
    fn glUniform2f(location: i32, v0: f32, v1: f32);
    fn glUniform3f(location: i32, v0: f32, v1: f32, v2: f32);
    fn glUniform4f(location: i32, v0: f32, v1: f32, v2: f32, v3: f32);
    fn glUniform3fv(location: i32, count: i32, value: *const f32);
    fn glUniform1fv(location: i32, count: i32, value: *const f32);
    fn glUniformMatrix4fv(location: i32, count: i32, transpose: u8, value: *const f32);

    fn glGenTextures(n: i32, textures: *mut u32);
    fn glDeleteTextures(n: i32, textures: *const u32);
    fn glBindTexture(target: u32, texture: u32);
    fn glActiveTexture(texture: u32);
    fn glTexParameteri(target: u32, pname: u32, param: i32);
    fn glTexImage2D(
        target: u32,
        level: i32,
        internalformat: i32,
        width: i32,
        height: i32,
        border: i32,
        format: u32,
        type_: u32,
        pixels: *const c_void,
    );

    fn glGenBuffers(n: i32, buffers: *mut u32);
    fn glDeleteBuffers(n: i32, buffers: *const u32);
    fn glBindBuffer(target: u32, buffer: u32);
    fn glBufferData(target: u32, size: isize, data: *const c_void, usage: u32);

    fn glGenVertexArrays(n: i32, arrays: *mut u32);
    fn glDeleteVertexArrays(n: i32, arrays: *const u32);
    fn glBindVertexArray(array: u32);
    fn glVertexAttribPointer(
        index: u32,
        size: i32,
        type_: u32,
        normalized: u8,
        stride: i32,
        pointer: *const c_void,
    );
    fn glEnableVertexAttribArray(index: u32);
    fn glDisableVertexAttribArray(index: u32);

    fn glDrawArrays(mode: u32, first: i32, count: i32);
    fn glDrawElements(mode: u32, count: i32, type_: u32, indices: *const c_void);

    fn glGenFramebuffers(n: i32, framebuffers: *mut u32);
    fn glDeleteFramebuffers(n: i32, framebuffers: *const u32);
    fn glBindFramebuffer(target: u32, framebuffer: u32);
    fn glFramebufferTexture2D(
        target: u32,
        attachment: u32,
        textarget: u32,
        texture: u32,
        level: i32,
    );
    fn glCheckFramebufferStatus(target: u32) -> u32;
    fn glDrawBuffers(n: i32, bufs: *const u32);
    fn glPixelStorei(pname: u32, param: i32);
    fn glDrawBuffer(mode: u32);
    fn glReadPixels(
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        format: u32,
        ty: u32,
        data: *mut c_void,
    );
    fn glGetError() -> u32;
    fn glFinish();
    fn glVertexAttribDivisor(index: u32, divisor: u32);
    fn glDrawElementsInstanced(
        mode: u32,
        count: i32,
        type_: u32,
        indices: *const c_void,
        primcount: i32,
    );
    fn glDrawArraysInstanced(mode: u32, first: i32, count: i32, primcount: i32);
    fn glTexImage3D(
        target: u32,
        level: i32,
        internalformat: i32,
        width: i32,
        height: i32,
        depth: i32,
        border: i32,
        format: u32,
        type_: u32,
        pixels: *const c_void,
    );
    fn glTexSubImage3D(
        target: u32,
        level: i32,
        xoffset: i32,
        yoffset: i32,
        zoffset: i32,
        width: i32,
        height: i32,
        depth: i32,
        format: u32,
        type_: u32,
        pixels: *const c_void,
    );
    fn glGenerateMipmap(target: u32);
}

// Wrappers
pub fn clear_color(r: f32, g: f32, b: f32, a: f32) {
    unsafe {
        glClearColor(r, g, b, a);
    }
}

pub fn read_pixels(x: i32, y: i32, w: i32, h: i32, format: u32, ty: u32, data: &mut [u8]) {
    unsafe {
        glReadPixels(x, y, w, h, format, ty, data.as_mut_ptr() as *mut c_void);
    }
}

pub fn get_error() -> u32 {
    unsafe { glGetError() }
}

pub fn finish() {
    unsafe {
        glFinish();
    }
}

pub fn clear(mask: u32) {
    unsafe {
        glClear(mask);
    }
}

pub fn viewport(x: i32, y: i32, w: i32, h: i32) {
    unsafe {
        glViewport(x, y, w, h);
    }
}

pub fn enable(cap: u32) {
    unsafe {
        glEnable(cap);
    }
}

pub fn disable(cap: u32) {
    unsafe {
        glDisable(cap);
    }
}

pub fn cull_face(mode: u32) {
    unsafe {
        glCullFace(mode);
    }
}

pub fn depth_mask(flag: bool) {
    unsafe {
        glDepthMask(if flag { 1 } else { 0 });
    }
}

pub fn color_mask(r: bool, g: bool, b: bool, a: bool) {
    unsafe {
        glColorMask(
            if r { 1 } else { 0 },
            if g { 1 } else { 0 },
            if b { 1 } else { 0 },
            if a { 1 } else { 0 },
        );
    }
}

pub fn blend_func(sfactor: u32, dfactor: u32) {
    unsafe {
        glBlendFunc(sfactor, dfactor);
    }
}

pub fn create_shader(type_: u32) -> u32 {
    unsafe { glCreateShader(type_) }
}

pub fn shader_source(shader: u32, src: &[u8]) {
    let ptr = src.as_ptr();
    let len = src.len() as i32;
    unsafe {
        glShaderSource(shader, 1, &ptr, &len);
    }
}

pub fn compile_shader(shader: u32) {
    unsafe {
        glCompileShader(shader);
    }
}

pub fn get_shaderiv(shader: u32, pname: u32) -> i32 {
    let mut param = 0;
    unsafe {
        glGetShaderiv(shader, pname, &mut param);
    }
    param
}

pub fn get_shader_info_log(shader: u32, buf: &mut [u8]) -> usize {
    let mut length = 0;
    unsafe {
        glGetShaderInfoLog(shader, buf.len() as i32, &mut length, buf.as_mut_ptr());
    }
    length as usize
}

pub fn delete_shader(shader: u32) {
    unsafe {
        glDeleteShader(shader);
    }
}

pub fn create_program() -> u32 {
    unsafe { glCreateProgram() }
}

pub fn attach_shader(program: u32, shader: u32) {
    unsafe {
        glAttachShader(program, shader);
    }
}

pub fn link_program(program: u32) {
    unsafe {
        glLinkProgram(program);
    }
}

pub fn get_programiv(program: u32, pname: u32) -> i32 {
    let mut param = 0;
    unsafe {
        glGetProgramiv(program, pname, &mut param);
    }
    param
}

pub fn get_program_info_log(program: u32, buf: &mut [u8]) -> usize {
    let mut length = 0;
    unsafe {
        glGetProgramInfoLog(program, buf.len() as i32, &mut length, buf.as_mut_ptr());
    }
    length as usize
}

pub fn use_program(program: u32) {
    unsafe {
        glUseProgram(program);
    }
}

pub fn delete_program(program: u32) {
    unsafe {
        glDeleteProgram(program);
    }
}

pub fn get_uniform_location(program: u32, name: &str) -> i32 {
    let mut name_c = name.as_bytes().to_vec();
    name_c.push(0);
    unsafe { glGetUniformLocation(program, name_c.as_ptr()) }
}

pub fn uniform1i(location: i32, value: i32) {
    unsafe {
        glUniform1i(location, value);
    }
}

pub fn uniform1f(location: i32, value: f32) {
    unsafe {
        glUniform1f(location, value);
    }
}

pub fn uniform2f(location: i32, x: f32, y: f32) {
    unsafe {
        glUniform2f(location, x, y);
    }
}

pub fn uniform3f(location: i32, x: f32, y: f32, z: f32) {
    unsafe {
        glUniform3f(location, x, y, z);
    }
}

pub fn uniform4f(location: i32, x: f32, y: f32, z: f32, w: f32) {
    unsafe {
        glUniform4f(location, x, y, z, w);
    }
}

pub fn uniform1fv(location: i32, values: &[f32]) {
    unsafe {
        glUniform1fv(location, values.len() as i32, values.as_ptr());
    }
}

pub fn uniform3fv(location: i32, values: &[f32]) {
    unsafe {
        glUniform3fv(location, (values.len() / 3) as i32, values.as_ptr());
    }
}

pub fn uniform_matrix4fv(location: i32, transpose: bool, values: &[f32; 16]) {
    unsafe {
        glUniformMatrix4fv(location, 1, if transpose { 1 } else { 0 }, values.as_ptr());
    }
}

pub fn uniform_matrix4fv_array(location: i32, values: &[f32]) {
    unsafe {
        glUniformMatrix4fv(location, (values.len() / 16) as i32, 0, values.as_ptr());
    }
}

pub fn vertex_attrib_divisor(index: u32, divisor: u32) {
    unsafe {
        glVertexAttribDivisor(index, divisor);
    }
}

pub fn draw_elements_instanced(mode: u32, count: i32, type_: u32, offset: u32, primcount: i32) {
    unsafe {
        glDrawElementsInstanced(
            mode,
            count,
            type_,
            offset as usize as *const c_void,
            primcount,
        );
    }
}

pub fn draw_arrays_instanced(mode: u32, first: i32, count: i32, primcount: i32) {
    unsafe {
        glDrawArraysInstanced(mode, first, count, primcount);
    }
}

pub fn gen_texture() -> u32 {
    let mut tex = 0;
    unsafe {
        glGenTextures(1, &mut tex);
    }
    tex
}

pub fn delete_texture(texture: u32) {
    unsafe {
        glDeleteTextures(1, &texture);
    }
}

pub fn bind_texture(target: u32, texture: u32) {
    unsafe {
        glBindTexture(target, texture);
    }
}

pub fn active_texture(unit: u32) {
    unsafe {
        glActiveTexture(unit);
    }
}

pub fn tex_parameteri(target: u32, pname: u32, param: i32) {
    unsafe {
        glTexParameteri(target, pname, param);
    }
}

#[allow(clippy::too_many_arguments)]
pub fn tex_image_2d(
    target: u32,
    level: i32,
    internal_format: i32,
    width: i32,
    height: i32,
    border: i32,
    format: u32,
    type_: u32,
    data: Option<&[u8]>,
) {
    let ptr = match data {
        Some(d) => d.as_ptr() as *const c_void,
        None => std::ptr::null(),
    };
    unsafe {
        glTexImage2D(
            target,
            level,
            internal_format,
            width,
            height,
            border,
            format,
            type_,
            ptr,
        );
    }
}

pub fn gen_buffer() -> u32 {
    let mut buf = 0;
    unsafe {
        glGenBuffers(1, &mut buf);
    }
    buf
}

pub fn delete_buffer(buffer: u32) {
    unsafe {
        glDeleteBuffers(1, &buffer);
    }
}

pub fn bind_buffer(target: u32, buffer: u32) {
    unsafe {
        glBindBuffer(target, buffer);
    }
}

pub fn buffer_data(target: u32, data: &[u8], usage: u32) {
    unsafe {
        glBufferData(
            target,
            data.len() as isize,
            data.as_ptr() as *const c_void,
            usage,
        );
    }
}

pub fn gen_vertex_array() -> u32 {
    let mut vao = 0;
    unsafe {
        glGenVertexArrays(1, &mut vao);
    }
    vao
}

pub fn delete_vertex_array(vao: u32) {
    unsafe {
        glDeleteVertexArrays(1, &vao);
    }
}

pub fn bind_vertex_array(vao: u32) {
    unsafe {
        glBindVertexArray(vao);
    }
}

pub fn vertex_attrib_pointer(
    index: u32,
    size: i32,
    type_: u32,
    normalized: bool,
    stride: i32,
    offset: u32,
) {
    unsafe {
        glVertexAttribPointer(
            index,
            size,
            type_,
            if normalized { 1 } else { 0 },
            stride,
            offset as usize as *const c_void,
        );
    }
}

pub fn enable_vertex_attrib_array(index: u32) {
    unsafe {
        glEnableVertexAttribArray(index);
    }
}

pub fn disable_vertex_attrib_array(index: u32) {
    unsafe {
        glDisableVertexAttribArray(index);
    }
}

pub fn draw_arrays(mode: u32, first: i32, count: i32) {
    unsafe {
        glDrawArrays(mode, first, count);
    }
}

pub fn draw_elements(mode: u32, count: i32, type_: u32, offset: u32) {
    unsafe {
        glDrawElements(mode, count, type_, offset as usize as *const c_void);
    }
}

pub fn gen_framebuffer() -> u32 {
    let mut fbo = 0;
    unsafe {
        glGenFramebuffers(1, &mut fbo);
    }
    fbo
}

pub fn delete_framebuffer(fbo: u32) {
    unsafe {
        glDeleteFramebuffers(1, &fbo);
    }
}

pub fn bind_framebuffer(target: u32, framebuffer: u32) {
    unsafe {
        glBindFramebuffer(target, framebuffer);
    }
}

pub fn framebuffer_texture_2d(
    target: u32,
    attachment: u32,
    textarget: u32,
    texture: u32,
    level: i32,
) {
    unsafe {
        glFramebufferTexture2D(target, attachment, textarget, texture, level);
    }
}

pub fn check_framebuffer_status(target: u32) -> u32 {
    unsafe { glCheckFramebufferStatus(target) }
}

pub fn draw_buffers(buffers: &[u32]) {
    unsafe {
        glDrawBuffers(buffers.len() as i32, buffers.as_ptr());
    }
}

pub fn pixel_storei(pname: u32, param: i32) {
    unsafe {
        glPixelStorei(pname, param);
    }
}

pub fn disable_draw_buffer() {
    unsafe {
        glDrawBuffer(0); // GL_NONE
    }
}

#[allow(clippy::too_many_arguments)]
pub fn tex_image_3d(
    target: u32,
    level: i32,
    internal_format: i32,
    width: i32,
    height: i32,
    depth: i32,
    border: i32,
    format: u32,
    type_: u32,
    data: Option<&[u8]>,
) {
    let ptr = match data {
        Some(d) => d.as_ptr() as *const c_void,
        None => core::ptr::null(),
    };
    unsafe {
        glTexImage3D(
            target,
            level,
            internal_format,
            width,
            height,
            depth,
            border,
            format,
            type_,
            ptr,
        );
    }
}

#[allow(clippy::too_many_arguments)]
pub fn tex_sub_image_3d(
    target: u32,
    level: i32,
    xoffset: i32,
    yoffset: i32,
    zoffset: i32,
    width: i32,
    height: i32,
    depth: i32,
    format: u32,
    type_: u32,
    data: &[u8],
) {
    unsafe {
        glTexSubImage3D(
            target,
            level,
            xoffset,
            yoffset,
            zoffset,
            width,
            height,
            depth,
            format,
            type_,
            data.as_ptr() as *const c_void,
        );
    }
}

pub fn generate_mipmap(target: u32) {
    unsafe {
        glGenerateMipmap(target);
    }
}

pub fn get_integer(pname: u32) -> i32 {
    let mut value = 0;
    unsafe {
        glGetIntegerv(pname, &mut value);
    }
    value
}

/// Native always supports RGBA16F color attachments (GL 3.3 core).
pub fn cap_half_float_target() -> bool {
    true
}
