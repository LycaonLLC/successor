//! OpenGL implementation of the Gpu trait.

use std::collections::HashMap;
use successor_engine_render::gpu::{
    Gpu, BufferId, ProgramId, TextureId, RenderTargetId, BufferUsage, TextureDesc,
    RenderTargetDesc, PassTarget, RectPx, ClearSpec, PipelineState, Cull, Uniform,
    UniformValue, VertexLayout, TextureFormat, Filter,
};

#[cfg(not(target_arch = "wasm32"))]
use crate::native::gl;

#[cfg(target_arch = "wasm32")]
use crate::web::gl;

struct RenderTarget {
    fbo: u32,
    color_tex: Option<TextureId>,
    depth_tex: Option<TextureId>,
}

pub struct GlGpu {
    #[allow(dead_code)]
    vao: u32,
    uniform_cache: HashMap<u32, HashMap<&'static str, i32>>,
    render_targets: Vec<RenderTarget>,
    active_program: u32,
}

impl GlGpu {
    pub fn new() -> Self {
        let vao = gl::gen_vertex_array();
        gl::bind_vertex_array(vao);

        Self {
            vao,
            uniform_cache: HashMap::new(),
            render_targets: Vec::new(),
            active_program: 0,
        }
    }
}

impl Gpu for GlGpu {
    fn create_buffer(&mut self, data: &[u8], usage: BufferUsage) -> BufferId {
        let handle = gl::gen_buffer();
        let gl_usage = match usage {
            BufferUsage::Static => gl::STATIC_DRAW,
            BufferUsage::Dynamic => gl::DYNAMIC_DRAW,
        };
        gl::bind_buffer(gl::ARRAY_BUFFER, handle);
        gl::buffer_data(gl::ARRAY_BUFFER, data, gl_usage);
        gl::bind_buffer(gl::ARRAY_BUFFER, 0);
        BufferId(handle)
    }

    fn update_buffer(&mut self, id: BufferId, data: &[u8]) {
        gl::bind_buffer(gl::ARRAY_BUFFER, id.0);
        gl::buffer_data(gl::ARRAY_BUFFER, data, gl::DYNAMIC_DRAW);
        gl::bind_buffer(gl::ARRAY_BUFFER, 0);
    }

    fn create_program(&mut self, vert_src: &str, frag_src: &str) -> ProgramId {
        let header = if cfg!(target_arch = "wasm32") {
            "#version 300 es\nprecision highp float;\nprecision highp sampler2D;\n"
        } else {
            "#version 330 core\n"
        };

        let vert_full = format!("{}{}", header, vert_src);
        let frag_full = format!("{}{}", header, frag_src);

        let vs = gl::create_shader(gl::VERTEX_SHADER);
        gl::shader_source(vs, vert_full.as_bytes());
        gl::compile_shader(vs);

        let vs_ok = gl::get_shaderiv(vs, gl::COMPILE_STATUS);
        if vs_ok == 0 {
            let mut info = [0u8; 1024];
            let len = gl::get_shader_info_log(vs, &mut info);
            let log_msg = std::str::from_utf8(&info[..len]).unwrap_or("unknown error");
            successor_engine_core::rt::log::log_str("Vertex shader compile error:\n");
            successor_engine_core::rt::log::log_str(log_msg);
            successor_engine_core::rt::log::log_str("\n");
        }

        let fs = gl::create_shader(gl::FRAGMENT_SHADER);
        gl::shader_source(fs, frag_full.as_bytes());
        gl::compile_shader(fs);

        let fs_ok = gl::get_shaderiv(fs, gl::COMPILE_STATUS);
        if fs_ok == 0 {
            let mut info = [0u8; 1024];
            let len = gl::get_shader_info_log(fs, &mut info);
            let log_msg = std::str::from_utf8(&info[..len]).unwrap_or("unknown error");
            successor_engine_core::rt::log::log_str("Fragment shader compile error:\n");
            successor_engine_core::rt::log::log_str(log_msg);
            successor_engine_core::rt::log::log_str("\n");
        }

        let program = gl::create_program();
        gl::attach_shader(program, vs);
        gl::attach_shader(program, fs);
        gl::link_program(program);

        let link_ok = gl::get_programiv(program, gl::LINK_STATUS);
        if link_ok == 0 {
            let mut info = [0u8; 1024];
            let len = gl::get_program_info_log(program, &mut info);
            let log_msg = std::str::from_utf8(&info[..len]).unwrap_or("unknown error");
            successor_engine_core::rt::log::log_str("Program link error:\n");
            successor_engine_core::rt::log::log_str(log_msg);
            successor_engine_core::rt::log::log_str("\n");
        }

        gl::delete_shader(vs);
        gl::delete_shader(fs);

        ProgramId(program)
    }

    fn create_texture(&mut self, desc: &TextureDesc, data: Option<&[u8]>) -> TextureId {
        let handle = gl::gen_texture();
        gl::bind_texture(gl::TEXTURE_2D, handle);
        gl::pixel_storei(gl::UNPACK_ALIGNMENT, 1);

        let filter = match desc.filter {
            Filter::Nearest => gl::NEAREST,
            Filter::Linear => gl::LINEAR,
        };

        gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, filter);
        gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, filter);
        gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE);
        gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE);

        let (internal_format, format, ty) = match desc.format {
            TextureFormat::Rgba8 => (gl::RGBA8 as i32, gl::RGBA, gl::UNSIGNED_BYTE),
            TextureFormat::Depth => (gl::DEPTH_COMPONENT24 as i32, gl::DEPTH_COMPONENT, gl::UNSIGNED_INT),
        };

        gl::tex_image_2d(
            gl::TEXTURE_2D,
            0,
            internal_format,
            desc.width as i32,
            desc.height as i32,
            0,
            format,
            ty,
            data,
        );

        gl::bind_texture(gl::TEXTURE_2D, 0);
        TextureId(handle)
    }

    fn create_render_target(&mut self, desc: &RenderTargetDesc) -> RenderTargetId {
        let fbo = gl::gen_framebuffer();
        gl::bind_framebuffer(gl::FRAMEBUFFER, fbo);

        let filter = match desc.filter {
            Filter::Nearest => gl::NEAREST,
            Filter::Linear => gl::LINEAR,
        };

        let color_tex = if desc.color {
            let handle = gl::gen_texture();
            gl::bind_texture(gl::TEXTURE_2D, handle);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, filter);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, filter);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE);
            gl::tex_image_2d(
                gl::TEXTURE_2D,
                0,
                gl::RGBA8 as i32,
                desc.width as i32,
                desc.height as i32,
                0,
                gl::RGBA,
                gl::UNSIGNED_BYTE,
                None,
            );
            gl::framebuffer_texture_2d(
                gl::FRAMEBUFFER,
                gl::COLOR_ATTACHMENT0,
                gl::TEXTURE_2D,
                handle,
                0,
            );
            Some(TextureId(handle))
        } else {
            None
        };

        let depth_tex = if desc.depth {
            let handle = gl::gen_texture();
            gl::bind_texture(gl::TEXTURE_2D, handle);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, filter);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, filter);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE);
            gl::tex_image_2d(
                gl::TEXTURE_2D,
                0,
                gl::DEPTH_COMPONENT24 as i32,
                desc.width as i32,
                desc.height as i32,
                0,
                gl::DEPTH_COMPONENT,
                gl::UNSIGNED_INT,
                None,
            );
            gl::framebuffer_texture_2d(
                gl::FRAMEBUFFER,
                gl::DEPTH_ATTACHMENT,
                gl::TEXTURE_2D,
                handle,
                0,
            );
            Some(TextureId(handle))
        } else {
            None
        };

        if !desc.color {
            gl::disable_draw_buffer();
        }

        let status = gl::check_framebuffer_status(gl::FRAMEBUFFER);
        if status != gl::FRAMEBUFFER_COMPLETE {
            successor_engine_core::rt::log::log1u("Framebuffer incomplete status: ", status as u64);
            successor_engine_core::rt::log::log_str("\n");
        }

        gl::bind_framebuffer(gl::FRAMEBUFFER, 0);

        let rt_idx = self.render_targets.len() as u32 + 1;
        self.render_targets.push(RenderTarget {
            fbo,
            color_tex,
            depth_tex,
        });

        RenderTargetId(rt_idx)
    }

    fn render_target_color(&self, rt: RenderTargetId) -> Option<TextureId> {
        let idx = rt.0 as usize - 1;
        if idx < self.render_targets.len() {
            self.render_targets[idx].color_tex
        } else {
            None
        }
    }

    fn render_target_depth(&self, rt: RenderTargetId) -> Option<TextureId> {
        let idx = rt.0 as usize - 1;
        if idx < self.render_targets.len() {
            self.render_targets[idx].depth_tex
        } else {
            None
        }
    }

    fn begin_pass(&mut self, target: PassTarget, viewport: RectPx, clear: ClearSpec) {
        match target {
            PassTarget::Screen => {
                gl::bind_framebuffer(gl::FRAMEBUFFER, 0);
            }
            PassTarget::RenderTarget(rt_id) => {
                let idx = rt_id.0 as usize - 1;
                if idx < self.render_targets.len() {
                    gl::bind_framebuffer(gl::FRAMEBUFFER, self.render_targets[idx].fbo);
                }
            }
        }
        gl::viewport(viewport.x, viewport.y, viewport.w, viewport.h);

        let mut mask = 0;
        if let Some(color) = clear.color {
            gl::clear_color(color[0], color[1], color[2], color[3]);
            mask |= gl::COLOR_BUFFER_BIT;
        }
        if clear.depth.is_some() {
            gl::depth_mask(true);
            mask |= gl::DEPTH_BUFFER_BIT;
        }
        if mask != 0 {
            gl::clear(mask);
        }
    }

    fn set_pipeline(&mut self, program: ProgramId, state: &PipelineState) {
        gl::use_program(program.0);
        self.active_program = program.0;

        if state.depth_test {
            gl::enable(gl::DEPTH_TEST);
        } else {
            gl::disable(gl::DEPTH_TEST);
        }

        gl::depth_mask(state.depth_write);

        match state.cull {
            Cull::None => {
                gl::disable(gl::CULL_FACE);
            }
            Cull::Back => {
                gl::enable(gl::CULL_FACE);
                gl::cull_face(gl::BACK);
            }
            Cull::Front => {
                gl::enable(gl::CULL_FACE);
                gl::cull_face(gl::FRONT);
            }
        }

        gl::color_mask(
            state.color_write,
            state.color_write,
            state.color_write,
            state.color_write,
        );
    }

    fn set_uniforms(&mut self, uniforms: &[Uniform]) {
        let program = self.active_program;
        if program == 0 {
            return;
        }

        // Safe steady-state lock-free lookup
        let has_key = if let Some(cache) = self.uniform_cache.get(&program) {
            let mut all_found = true;
            for u in uniforms {
                if !cache.contains_key(u.name) {
                    all_found = false;
                    break;
                }
            }
            all_found
        } else {
            false
        };

        if !has_key {
            // Allocate once during first frame or load
            let cache = self.uniform_cache.entry(program).or_insert_with(HashMap::new);
            for u in uniforms {
                if !cache.contains_key(u.name) {
                    let loc = gl::get_uniform_location(program, u.name);
                    cache.insert(u.name, loc);
                }
            }
        }

        let cache = self.uniform_cache.get(&program).unwrap();
        for u in uniforms {
            if let Some(&loc) = cache.get(u.name) {
                if loc == -1 {
                    continue;
                }
                match u.value {
                    UniformValue::Float(v) => gl::uniform1f(loc, v),
                    UniformValue::Vec3(v) => gl::uniform3f(loc, v[0], v[1], v[2]),
                    UniformValue::Vec4(v) => gl::uniform4f(loc, v[0], v[1], v[2], v[3]),
                    UniformValue::Mat4(v) => gl::uniform_matrix4fv(loc, false, &v),
                    UniformValue::Int(v) => gl::uniform1i(loc, v),
                    UniformValue::Sampler(v) => gl::uniform1i(loc, v),
                }
            }
        }
    }

    fn bind_texture(&mut self, slot: u32, tex: TextureId) {
        gl::active_texture(gl::TEXTURE0 + slot);
        gl::bind_texture(gl::TEXTURE_2D, tex.0);
    }

    fn draw(
        &mut self,
        vertices: BufferId,
        indices: Option<BufferId>,
        layout: &VertexLayout,
        count: u32,
    ) {
        gl::bind_buffer(gl::ARRAY_BUFFER, vertices.0);

        for attr in layout.attrs {
            gl::enable_vertex_attrib_array(attr.location);
            gl::vertex_attrib_pointer(
                attr.location,
                attr.components as i32,
                gl::FLOAT,
                false,
                layout.stride as i32,
                attr.offset,
            );
        }

        if let Some(ebo) = indices {
            gl::bind_buffer(gl::ELEMENT_ARRAY_BUFFER, ebo.0);
            gl::draw_elements(gl::TRIANGLES, count as i32, gl::UNSIGNED_INT, 0);
            gl::bind_buffer(gl::ELEMENT_ARRAY_BUFFER, 0);
        } else {
            gl::draw_arrays(gl::TRIANGLES, 0, count as i32);
        }

        for attr in layout.attrs {
            gl::disable_vertex_attrib_array(attr.location);
        }

        gl::bind_buffer(gl::ARRAY_BUFFER, 0);
    }

    fn end_pass(&mut self) {
        gl::bind_framebuffer(gl::FRAMEBUFFER, 0);
    }
}
